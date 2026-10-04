import fs, { lstat as mediaLstat, realpath as mediaRealpath } from "node:fs/promises";
import path from "node:path";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { stageGatewayWorkspaceMedia } from "../infra/outbound/message-action-gateway-media.js";
import * as brokerReply from "../infra/sqlite-worker-broker-reply.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import * as stateRead from "../state/openclaw-state-db-readonly.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { HostReadMediaTypeError } from "./local-media-access.js";
import { cleanOldMedia, pruneOutboundMedia, saveMediaBuffer } from "./store.js";
import {
  loadWebMedia,
  markTrustedGeneratedHtmlPath,
  pruneStaleTrustedGeneratedHtmlMarkers,
} from "./web-media.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), realpath: vi.fn(actual.realpath) };
});

const html = Buffer.from("<!doctype html><title>Report</title><h1>Original</h1>");
const replacement = Buffer.from("<!doctype html><title>Report</title><h1>Replaced</h1>");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(mediaLstat).mockReset();
    vi.mocked(mediaRealpath).mockReset();
    await closeStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

describe("generated HTML provenance worker boundary", () => {
  let stateDir: string;
  let workspace: string;

  beforeEach(() => {
    stateDir = tempDirs.make("html-provenance-state-");
    workspace = tempDirs.make("html-provenance-workspace-", resolvePreferredOpenClawTmpDir());
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  const readHtml = (file: string) =>
    loadWebMedia(file, {
      localRoots: [stateDir],
      readFile: (source) => fs.readFile(source),
      hostReadCapability: true,
    });

  async function stageHtml() {
    const source = path.join(workspace, "report.html");
    await fs.writeFile(source, html);
    const access = { localRoots: [workspace], readFile: (file: string) => fs.readFile(file) };
    const result = await stageGatewayWorkspaceMedia({
      cfg: {},
      channel: "discord",
      payload: { text: "Report", mediaUrl: source },
      mediaUrls: [source],
      mediaAccess: access,
      workspaceMediaAccess: access,
    });
    expect(result.mediaUrl).toBeDefined();
    expect(result.mediaUrl).not.toBe(source);
    return result.mediaUrl!;
  }

  it("stages, reloads, and prunes through both media entry points without caller SQL", async () => {
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      for (const prune of [
        () => cleanOldMedia(undefined, { recursive: true }),
        pruneOutboundMedia,
      ]) {
        const staged = await stageHtml();
        expect(await readHtml(staged)).toMatchObject({
          buffer: html,
          contentType: "text/html",
          trustedGeneratedHtmlSource: true,
        });
        await fs.utimes(staged, new Date(0), new Date(0));
        await prune();
        await expect(fs.stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
        await fs.mkdir(path.dirname(staged), { recursive: true });
        await fs.writeFile(staged, html);
        await expect(readHtml(staged)).rejects.toBeInstanceOf(HostReadMediaTypeError);
      }
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it("fails closed when worker lookup is refused", async () => {
    const staged = await stageHtml();
    const refusal = new StateDatabaseReadAdmissionInvalidatedError("Reader authority revoked");
    const read = vi
      .spyOn(stateRead, "executeExistingOpenClawStateRead")
      .mockRejectedValueOnce(refusal);
    await expect(readHtml(staged)).rejects.toBeInstanceOf(HostReadMediaTypeError);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();
    expect((await readHtml(staged)).buffer).toEqual(html);
  });

  it.each([
    { operation: "upsert", stage: "transaction" },
    { operation: "upsert", stage: "commit" },
    { operation: "prune", stage: "transaction" },
    { operation: "prune", stage: "commit" },
  ] as const)(
    "rolls back $operation at $stage and retains the refusal identity",
    async ({ operation, stage }) => {
      const staged = await stageHtml();
      if (operation === "prune") {
        await fs.rm(staged);
      }
      const refusal = new StateDatabaseReadAdmissionInvalidatedError("Writer authority revoked");
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const requests: string[] = [];
      const interception = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          createAdmission((request, grant) => {
            requests.push(request.stage);
            if (request.stage === stage) {
              throw refusal;
            }
            admit(request, grant);
          }, attachment),
        );
      const writing =
        operation === "upsert"
          ? markTrustedGeneratedHtmlPath(staged, replacement)
          : pruneStaleTrustedGeneratedHtmlMarkers();
      await expect(writing).rejects.toBe(refusal);
      await expect(writing).rejects.toBeInstanceOf(StateDatabaseReadAdmissionInvalidatedError);
      expect(requests).toContain(stage);
      interception.mockRestore();
      if (operation === "prune") {
        await fs.writeFile(staged, html);
      }
      expect((await readHtml(staged)).buffer).toEqual(html);
    },
  );

  it("recovers committed upsert and cleanup receipts when ordinary replies are lost", async () => {
    const receive = brokerReply.receiveSqliteWorkerReply;
    const corrupted: string[] = [];
    vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation((slot, reply, owner) => {
      if (slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input) {
        const command: unknown = deserialize(slot.current.request.input);
        if (
          isRecord(command) &&
          (command.type === "generatedHtmlProvenance.upsert" ||
            command.type === "generatedHtmlProvenance.prune")
        ) {
          corrupted.push(command.type);
          return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
        }
      }
      return receive(slot, reply, owner);
    });
    const staged = await stageHtml();
    expect((await readHtml(staged)).buffer).toEqual(html);
    await fs.rm(staged);
    await pruneStaleTrustedGeneratedHtmlMarkers();
    await fs.writeFile(staged, html);
    await expect(readHtml(staged)).rejects.toBeInstanceOf(HostReadMediaTypeError);
    expect(corrupted).toEqual(["generatedHtmlProvenance.upsert", "generatedHtmlProvenance.prune"]);
  });

  it.each(["upsert", "prune"] as const)(
    "does not replay an unknown %s outcome",
    async (operation) => {
      const staged = await stageHtml();
      if (operation === "prune") {
        await fs.rm(staged);
      }
      const failure = new SqliteWorkerError("Native outcome is unknown", "outcome-unknown");
      const run = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockRejectedValueOnce(failure);
      const writing =
        operation === "upsert"
          ? markTrustedGeneratedHtmlPath(staged, replacement)
          : pruneStaleTrustedGeneratedHtmlMarkers();
      await expect(writing).rejects.toBe(failure);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it("pins the marker store and bytes before filesystem work yields", async (test) => {
    const saved = await saveMediaBuffer(html, "text/html", "outbound", 1024, "report.html");
    const entered = createDeferred();
    const release = createDeferred();
    const realpath = fs.realpath;
    const intercept = vi.mocked(mediaRealpath).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return realpath(...args);
    });
    const contents = Buffer.from(html);
    const marking = markTrustedGeneratedHtmlPath(saved.path, contents);
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, marking, "Marker skipped filesystem admission"),
        test.signal,
      );
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("html-provenance-other-"));
      replacement.copy(contents);
      release.resolve();
      await marking;
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      expect((await readHtml(saved.path)).buffer).toEqual(html);
    } finally {
      release.resolve();
      await Promise.allSettled([marking]);
      intercept.mockRestore();
    }
  });

  it("does not prune a newer marker committed while stale file inspection waits", async (test) => {
    const staged = await stageHtml();
    await fs.rm(staged);
    const entered = createDeferred();
    const release = createDeferred();
    const lstat = fs.lstat;
    const intercept = vi.mocked(mediaLstat).mockImplementation(async (...args) => {
      if (String(args[0]) === staged) {
        intercept.mockRestore();
        entered.resolve();
        await release.promise;
        throw Object.assign(new Error("Stale file was absent"), { code: "ENOENT" });
      }
      return lstat(...args);
    });
    const pruning = pruneStaleTrustedGeneratedHtmlMarkers();
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, pruning, "Cleanup skipped file inspection"),
        test.signal,
      );
      await fs.writeFile(staged, replacement);
      await markTrustedGeneratedHtmlPath(staged, replacement);
      release.resolve();
      await pruning;
      expect((await readHtml(staged)).buffer).toEqual(replacement);
    } finally {
      release.resolve();
      await Promise.allSettled([pruning]);
      intercept.mockRestore();
    }
  });

  it("prunes the original store when state routing changes during file inspection", async (test) => {
    const staged = await stageHtml();
    await fs.rm(staged);
    const otherStateDir = tempDirs.make("html-provenance-cleanup-other-");
    const entered = createDeferred();
    const release = createDeferred();
    const intercept = vi.mocked(mediaLstat).mockImplementation(async (...args) => {
      if (String(args[0]) === staged) {
        intercept.mockRestore();
        entered.resolve();
        await release.promise;
      }
      return fs.lstat(...args);
    });
    const pruning = pruneStaleTrustedGeneratedHtmlMarkers();
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, pruning, "Cleanup skipped file inspection"),
        test.signal,
      );
      vi.stubEnv("OPENCLAW_STATE_DIR", otherStateDir);
      release.resolve();
      await pruning;
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await fs.writeFile(staged, html);
      await expect(readHtml(staged)).rejects.toBeInstanceOf(HostReadMediaTypeError);
      await expect(
        fs.stat(path.join(otherStateDir, "state", "openclaw.sqlite")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([pruning]);
      intercept.mockRestore();
    }
  });
});
