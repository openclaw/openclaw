import "./sessions-files.mocks.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isFileReferenceResult, type FileReferenceResult } from "../../shared/file-references.js";
import * as fileRead from "./session-file-read.js";
import * as metadata from "./session-file-references.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFileDownloadClient,
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";
import * as workspace from "./workspace-fs.js";

const { sessionFilesMocks } = await import("./sessions-files.mocks.test-support.js");
const mocks = { ...sessionFilesMocks, execOpenPath: vi.fn() };
const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
const contextSnapshot = {
  captureId: "capture",
  generation: 1,
  transcriptRevision: 3,
  targetId: "draft",
  draftRevision: 4,
};
let directory: string;
let entryOverrides: Partial<InternalSessionEntry>;

function entry(sessionKey: string): InternalSessionEntry {
  return { sessionId: sessionKey, updatedAt: 1, spawnedCwd: directory, ...entryOverrides };
}

const context = {
  getRuntimeConfig: () => cfg,
  workerSessionPlacementService: {
    getMany: () => new Map(),
    prepareRuntimeRefresh: async () => ({
      placement: undefined,
      move: undefined,
      pendingResult: undefined,
      assertCurrent: () => {},
      release: () => {},
    }),
  },
} satisfies Pick<GatewayRequestContext, "getRuntimeConfig" | "workerSessionPlacementService">;

beforeEach(() => {
  directory = prepareSessionFilesTest(mocks, createVisibleMessagesMock(mocks.readDelta));
  entryOverrides = {};
  mocks.loadSessionEntry.mockImplementation((sessionKey = "agent:main:main") => ({
    cfg,
    agentId: "main",
    canonicalKey: sessionKey,
    storePath: path.join(directory, ".sessions.json"),
    entry: entry(sessionKey),
  }));
  setRuntimeConfigSnapshot(cfg);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  removeWorkspaceFixture(directory);
});

async function request(
  client: GatewayClient,
  action: Record<string, unknown>,
  sessionKey = "agent:main:main",
): Promise<FileReferenceResult> {
  const options: Pick<GatewayRequestHandlerOptions, "client" | "withSessionTurnAuthority"> = {
    client,
    withSessionTurnAuthority: async (target, consume) => consume(entry(target.sessionKey)),
  };
  const calls = await invoke(
    "sessions.files.references",
    {
      schemaVersion: 1,
      sessionKey,
      context: contextSnapshot,
      ...action,
    },
    context,
    options,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  const result = calls[0]?.payload;
  if (!isFileReferenceResult(result)) {
    throw new Error("Expected a canonical file-reference result");
  }
  return result;
}

async function capability(client: GatewayClient, sessionKey?: string) {
  const ready = await request(client, { action: "capabilities" }, sessionKey);
  if (ready.status !== "ready") {
    throw new Error(`Capability unavailable: ${ready.status}`);
  }
  return ready.capability;
}

describe("sessions.files.references", () => {
  it("binds the live prepared backing and rechecks its owner before each operation", async () => {
    using connection = createSessionFileDownloadClient();
    const projection = path.join(directory, ".private-projection");
    await fs.mkdir(path.join(projection, "ui"), { recursive: true });
    await fs.writeFile(path.join(projection, "ui", "live.ts"), "fixture contents");
    let readRoot = projection;
    let current = true;
    // The existing read-path owner supplies a synthetic live projection; the
    // validated RPC, metadata index and object revalidation still use real files.
    const prepare = vi
      .spyOn(fileRead, "prepareSessionFileReadPath")
      .mockImplementation(async (params) => ({
        path: undefined,
        readRoot,
        assertCurrent: () => {
          params.assertCurrent();
          params.assertReadCurrent();
          if (!current) {
            throw new Error("Fixture backing replaced");
          }
        },
      }));
    const lease = await capability(connection.client);
    expect(lease.rootLabel).toBe(path.basename(directory));
    const found = await request(connection.client, {
      action: "search",
      leaseId: lease.leaseId,
      query: "ui/live.ts",
    });
    expect(found.status).toBe("matches");
    if (found.status !== "matches") {
      throw new Error("Expected live projection object");
    }
    expect(found.candidates.map((candidate) => candidate.reference.relativePath)).toEqual([
      "ui/live.ts",
    ]);
    const objectId = found.candidates[0]!.reference.objectId;
    expect(
      await request(connection.client, {
        action: "revalidate",
        leaseId: lease.leaseId,
        objectId,
      }),
    ).toEqual({ status: "validated", reference: found.candidates[0]!.reference });
    expect(prepare).toHaveBeenCalledTimes(3);
    readRoot = directory;
    expect(
      await request(connection.client, {
        action: "revalidate",
        leaseId: lease.leaseId,
        objectId,
      }),
    ).toEqual({ status: "denied" });
    readRoot = projection;
    current = false;
    expect(
      await request(connection.client, {
        action: "revalidate",
        leaseId: lease.leaseId,
        objectId,
      }),
    ).toEqual({ status: "denied" });
  });

  it("runs actual metadata search, revalidation and release through the validated RPC", async () => {
    using connection = createSessionFileDownloadClient();
    const contents = vi.spyOn(workspace, "readWorkspaceFile");
    const lease = await capability(connection.client);
    const found = await request(connection.client, {
      action: "search",
      leaseId: lease.leaseId,
      query: "ui/chat.ts",
    });
    expect(found.status).toBe("matches");
    if (found.status !== "matches") {
      throw new Error("Expected actual workspace match");
    }
    const reference = found.candidates[0]!.reference;
    expect(reference.relativePath).toBe("ui/chat.ts");
    expect(
      await request(connection.client, {
        action: "revalidate",
        leaseId: lease.leaseId,
        objectId: reference.objectId,
      }),
    ).toEqual({ status: "validated", reference });
    expect(contents).not.toHaveBeenCalled();
    expect(await request(connection.client, { action: "release", leaseId: lease.leaseId })).toEqual(
      { status: "released" },
    );
    expect(
      await request(connection.client, {
        action: "revalidate",
        leaseId: lease.leaseId,
        objectId: reference.objectId,
      }),
    ).toEqual({ status: "denied" });
  });

  it("rejects another connection's lease before searching metadata", async () => {
    using first = createSessionFileDownloadClient();
    using other = createSessionFileDownloadClient();
    const lease = await capability(first.client);
    const open = vi.spyOn(workspace, "openWorkspaceRoot");
    expect(
      await request(other.client, {
        action: "search",
        leaseId: lease.leaseId,
        query: "private.ts",
      }),
    ).toEqual({ status: "denied" });
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects every changed capture or destination context and a foreign session", async () => {
    using connection = createSessionFileDownloadClient();
    const lease = await capability(connection.client);
    for (const update of [
      { captureId: "other" },
      { generation: 2 },
      { transcriptRevision: 4 },
      { targetId: "other" },
      { draftRevision: 5 },
    ]) {
      expect(
        await request(connection.client, {
          action: "search",
          leaseId: lease.leaseId,
          query: "ui/chat.ts",
          context: { ...contextSnapshot, ...update },
        }),
      ).toEqual({ status: "denied" });
    }
    expect(
      await request(
        connection.client,
        { action: "search", leaseId: lease.leaseId, query: "ui/chat.ts" },
        "agent:main:other",
      ),
    ).toEqual({ status: "denied" });
  });

  it("rejects account and workspace authority changes", async () => {
    using connection = createSessionFileDownloadClient();
    const lease = await capability(connection.client);
    connection.client.authenticatedUserId = "different-account";
    expect(
      await request(connection.client, {
        action: "search",
        leaseId: lease.leaseId,
        query: "ui/chat.ts",
      }),
    ).toEqual({ status: "denied" });
    connection.client.authenticatedUserId = undefined;
    entryOverrides = { lifecycleRevision: "different-incarnation" };
    expect(
      await request(connection.client, {
        action: "search",
        leaseId: lease.leaseId,
        query: "ui/chat.ts",
      }),
    ).toEqual({ status: "denied" });
  });

  it("does not advertise a local identity contract for remote or repository ownership", async () => {
    using connection = createSessionFileDownloadClient();
    for (const override of [
      { repositoryWorkspaceId: "remote-repository" },
      { execNode: "remote-node" },
    ]) {
      entryOverrides = override;
      expect(await request(connection.client, { action: "capabilities" })).toEqual({
        status: "unsupported",
      });
    }
  });

  it("counts pending admissions against capacity and denies duplicate pending construction", async () => {
    using connection = createSessionFileDownloadClient();
    const entered = createDeferred();
    const release = createDeferred();
    const open = workspace.openWorkspaceRoot;
    let calls = 0;
    vi.spyOn(workspace, "openWorkspaceRoot").mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 8) {
        entered.resolve();
      }
      await release.promise;
      return await open(...args);
    });
    const pending = Array.from({ length: 8 }, (_, i) =>
      request(connection.client, { action: "capabilities" }, `agent:main:pending-${i}`),
    );
    await entered.promise;
    expect(
      await request(connection.client, { action: "capabilities" }, "agent:main:pending-0"),
    ).toEqual({ status: "denied" });
    expect(
      await request(connection.client, { action: "capabilities" }, "agent:main:overflow"),
    ).toEqual({ status: "denied" });
    expect(calls).toBe(8);
    release.resolve();
    expect((await Promise.all(pending)).every((result) => result.status === "ready")).toBe(true);
  });

  it("cleans a failed reservation so the same session can retry", async () => {
    using connection = createSessionFileDownloadClient();
    vi.spyOn(workspace, "openWorkspaceRoot").mockRejectedValueOnce(
      new Error("private root failure"),
    );
    expect(await request(connection.client, { action: "capabilities" })).toEqual({
      status: "denied",
    });
    expect((await request(connection.client, { action: "capabilities" })).status).toBe("ready");
  });

  it("does not publish a lease constructed after disconnection", async () => {
    using connection = createSessionFileDownloadClient();
    const entered = createDeferred();
    const release = createDeferred();
    const create = metadata.createLocalFileReferenceLease;
    let created: Awaited<ReturnType<typeof create>> | undefined;
    vi.spyOn(metadata, "createLocalFileReferenceLease").mockImplementation(async (options) => {
      created = await create(options);
      entered.resolve();
      await release.promise;
      return created;
    });
    const pending = request(connection.client, { action: "capabilities" });
    await entered.promise;
    connection[Symbol.dispose]();
    release.resolve();
    expect(await pending).toEqual({ status: "denied" });
    expect(await created?.search("ui/chat.ts", undefined, () => {})).toEqual({ status: "expired" });
  });

  it("releases a constructed lease when the final session authority fence fails", async () => {
    using connection = createSessionFileDownloadClient();
    const create = metadata.createLocalFileReferenceLease;
    let created: Awaited<ReturnType<typeof create>> | undefined;
    vi.spyOn(metadata, "createLocalFileReferenceLease").mockImplementationOnce(async (options) => {
      created = await create(options);
      entryOverrides = { lifecycleRevision: "replaced-during-admission" };
      return created;
    });
    expect(await request(connection.client, { action: "capabilities" })).toEqual({
      status: "denied",
    });
    expect(await created?.search("ui/chat.ts", undefined, () => {})).toEqual({ status: "expired" });
    expect((await request(connection.client, { action: "capabilities" })).status).toBe("ready");
  });
});
