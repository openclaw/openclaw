import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as fsSafe from "../infra/fs-safe.js";
import * as eventStore from "../memory-host-sdk/event-store.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { clearMemoryPluginState } from "../plugins/memory-state.test-fixtures.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { listMemoryHostPublicArtifacts } from "./memory-host-core.js";
import {
  memoryHostEventExportOwnerContent,
  publishMemoryHostEventArtifact,
} from "./memory-host-event-export.js";
import { appendMemoryHostEvent } from "./memory-host-events.js";

const recallEvent = (query: string) => ({
  type: "memory.recall.recorded" as const,
  timestamp: "2026-09-10T12:00:00.000Z",
  query,
  resultCount: 0,
  results: [],
});
const workspaceConfig = (workspace: string) => ({ agents: { entries: { main: { workspace } } } });
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

describe("memory host event export recovery", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let workspaceDir: string;
  let cfg: ReturnType<typeof workspaceConfig>;
  const event = recallEvent("first");
  beforeEach(async () => {
    state = await createOpenClawTestState({ layout: "state-only", prefix: "memory-host-export-" });
    workspaceDir = state.workspaceDir;
    cfg = workspaceConfig(workspaceDir);
  });
  const listArtifacts = () => listMemoryHostPublicArtifacts({ cfg });
  async function initialExport() {
    await appendMemoryHostEvent(workspaceDir, event);
    const artifact = (await listArtifacts()).find((entry) => entry.kind === "event-log");
    if (!artifact) {
      throw new Error("expected initial event export");
    }
    return artifact;
  }
  async function interruptedExport(inodeOwned: boolean) {
    const { stateDir } = state;
    await appendMemoryHostEvent(workspaceDir, event);
    const stateHash = sha256(await fs.realpath(stateDir)).slice(0, 32);
    const workspaceHash = sha256(await fs.realpath(workspaceDir)).slice(0, 32);
    const exportDir = path.join(workspaceDir, "memory", "events", stateHash);
    const exportPath = path.join(exportDir, "memory-host-events.jsonl");
    const ownerPath = path.join(exportDir, ".openclaw-memory-host-events-owner.json");
    const expectedContent = `${JSON.stringify(event)}\n`;
    await fs.mkdir(exportDir, { recursive: true });
    await fs.writeFile(exportPath, "", { mode: 0o600 });
    const identity = inodeOwned ? await fs.stat(exportPath, { bigint: true }) : undefined;
    await fs.writeFile(
      ownerPath,
      `${JSON.stringify({
        schemaVersion: inodeOwned ? 4 : 3,
        kind: "openclaw-memory-host-events-export",
        stateHash,
        workspaceHash,
        pendingContentSha256: sha256(expectedContent),
        ...(identity ? { fileDev: String(identity.dev), fileIno: String(identity.ino) } : {}),
      })}\n`,
      "utf8",
    );
    return { exportPath, ownerPath, expectedContent };
  }

  afterEach(async () => {
    await state.cleanup();
    clearMemoryPluginState();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["safe v3", 3, 7n, 11n, true, false],
    ["rounded v3 inode", 3, 7n, 9_007_199_254_740_993n, true, false],
    ["rounded v3 device", 3, 9_007_199_254_740_993n, 11n, true, false],
    [
      "unsigned high-bit v3 IDs",
      3,
      -9_223_372_036_854_775_807n,
      -9_223_372_036_854_775_805n,
      true,
      false,
    ],
    ["non-numeric-origin v3 spelling", 3, 7n, 9_007_199_254_740_993n, false, true],
    ["large exact v4", 4, 7n, 9_007_199_254_740_992n, true, false],
    ["signed exact v4", 4, -9_223_372_036_854_775_807n, -9_223_372_036_854_775_805n, true, false],
  ] as const)(
    "enforces ownership for a %s identity marker",
    async (_name, version, dev, ino, writable, exactLegacySpelling) => {
      const identity: { dev: bigint; ino: bigint } = { dev, ino };
      let observedIdentity = identity;
      const createRoot = fsSafe.root;
      vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
        const root = await createRoot(...args);
        // Preserve real file I/O while modeling the dependency's platform identity receipt.
        const open = root.open.bind(root);
        vi.spyOn(root, "open").mockImplementation(async (relativePath, options) => {
          const opened = await open(relativePath, options);
          if (relativePath.endsWith("/memory-host-events.jsonl")) {
            Object.defineProperty(opened, "exactIdentity", { value: observedIdentity });
          }
          return opened;
        });
        const openWritable = root.openWritable.bind(root);
        vi.spyOn(root, "openWritable").mockImplementation(async (relativePath, options) => {
          const opened = await openWritable(relativePath, options);
          if (relativePath.endsWith("/memory-host-events.jsonl")) {
            Object.defineProperty(opened, "exactIdentity", { value: observedIdentity });
          }
          return opened;
        });
        return root;
      });
      const artifact = await initialExport();
      const ownerPath = path.join(
        path.dirname(artifact.absolutePath),
        ".openclaw-memory-host-events-owner.json",
      );
      const marker = JSON.parse(await fs.readFile(ownerPath, "utf8"));
      expect(marker).toMatchObject({
        schemaVersion: 4,
        fileDev: String(identity.dev),
        fileIno: String(identity.ino),
      });
      // The released v3 writer stringified number stats, after any rounding.
      const ownerContent = `${JSON.stringify({
        ...marker,
        schemaVersion: version,
        ...(version === 3 && !exactLegacySpelling
          ? {
              fileDev: String(Number(BigInt.asUintN(64, identity.dev))),
              fileIno: String(Number(BigInt.asUintN(64, identity.ino))),
            }
          : {}),
      })}\n`;
      await fs.writeFile(ownerPath, ownerContent);
      if (writable) {
        // Even an unchanged export upgrades the marker to the exact observation.
        expect(await listArtifacts()).toContainEqual(artifact);
        expect(JSON.parse(await fs.readFile(ownerPath, "utf8"))).toMatchObject({
          schemaVersion: 4,
          fileDev: String(identity.dev),
          fileIno: String(identity.ino),
        });
      }
      await appendMemoryHostEvent(workspaceDir, { ...event, query: "second" });
      const artifacts = await listArtifacts();
      if (!writable) {
        expect(artifacts).not.toContainEqual(artifact);
        await expect(fs.readFile(artifact.absolutePath, "utf8")).resolves.toBe(
          `${JSON.stringify(event)}\n`,
        );
        await expect(fs.readFile(ownerPath, "utf8")).resolves.toBe(ownerContent);
        return;
      }
      expect(artifacts).toContainEqual(artifact);
      await expect(fs.readFile(artifact.absolutePath, "utf8")).resolves.toBe(
        `${JSON.stringify(event)}\n${JSON.stringify({ ...event, query: "second" })}\n`,
      );
      const exactOwnerContent = await fs.readFile(ownerPath, "utf8");
      observedIdentity =
        identity.dev > BigInt(Number.MAX_SAFE_INTEGER)
          ? { ...identity, dev: identity.dev ^ 1n }
          : { ...identity, ino: identity.ino ^ 1n };
      await fs.rename(artifact.absolutePath, `${artifact.absolutePath}.previous`);
      await fs.writeFile(artifact.absolutePath, "foreign replacement\n");
      await appendMemoryHostEvent(workspaceDir, { ...event, query: "third" });
      expect(await listArtifacts()).not.toContainEqual(artifact);
      await expect(fs.readFile(artifact.absolutePath, "utf8")).resolves.toBe(
        "foreign replacement\n",
      );
      await expect(fs.readFile(ownerPath, "utf8")).resolves.toBe(exactOwnerContent);
    },
  );

  it.each([false, true])(
    "waits for journal reads before replacing an export (read fails: %s)",
    async (readFails) => {
      const entered = createDeferred();
      const release = createDeferred();
      try {
        const artifact = await initialExport();
        const before = await fs.readFile(artifact.absolutePath, "utf8");
        await appendMemoryHostEvent(workspaceDir, { ...event, query: "second" });
        const failure = new Error("journal read failed");
        const list = eventStore.listStoredMemoryHostEvents;
        vi.spyOn(eventStore, "listStoredMemoryHostEvents").mockImplementationOnce(
          async (params) => {
            entered.resolve();
            await release.promise;
            if (readFails) {
              throw failure;
            }
            return await list(params);
          },
        );
        const result = listArtifacts().catch((error: unknown) => error);
        try {
          await entered.promise;
          expect(await fs.readFile(artifact.absolutePath, "utf8")).toBe(before);
        } finally {
          release.resolve();
          await result;
        }
        if (readFails) {
          expect(await result).toBe(failure);
          expect(await fs.readFile(artifact.absolutePath, "utf8")).toBe(before);
        } else {
          expect(await result).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: "event-log" })]),
          );
          expect(await fs.readFile(artifact.absolutePath, "utf8")).toContain('"query":"second"');
        }
      } finally {
        release.resolve();
      }
    },
  );

  it("does not finalize an initial export changed through the published inode", async () => {
    const fixtureRoot = state.root;
    const relativePath = "memory/events/state/memory-host-events.jsonl";
    const ownerRelativePath = "memory/events/state/.openclaw-memory-host-events-owner.json";
    const absolutePath = path.join(workspaceDir, relativePath);
    const owner = {
      queueKey: "state\0workspace",
      lockTarget: path.join(fixtureRoot, "lock"),
      relativePath,
      ownerRelativePath,
      stateHash: "state",
      workspaceHash: "workspace",
    };
    const content = '{"type":"memory.recall.recorded","query":"�"}\n';
    const expectedBytes = Buffer.from(content, "utf8");
    const replacementBytes = Buffer.from("�", "utf8");
    const replacementOffset = expectedBytes.indexOf(replacementBytes);
    const foreignBytes = Buffer.concat([
      expectedBytes.subarray(0, replacementOffset),
      Buffer.from([0x80]),
      expectedBytes.subarray(replacementOffset + replacementBytes.length),
    ]);
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    const expectedOwnerContent = memoryHostEventExportOwnerContent(owner, {
      pendingSha256: contentSha256,
    });
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, ownerRelativePath), expectedOwnerContent, "utf8");
    const workspaceRoot = await fsSafe.root(workspaceDir, {
      hardlinks: "reject",
      mkdir: true,
      mode: 0o600,
      symlinks: "reject",
    });
    const originalOpen = workspaceRoot.open.bind(workspaceRoot);
    let replacedContent = false;
    vi.spyOn(workspaceRoot, "open").mockImplementation(async (openedRelativePath, options) => {
      if (openedRelativePath === relativePath && !replacedContent) {
        replacedContent = true;
        await fs.writeFile(absolutePath, foreignBytes);
      }
      return await originalOpen(openedRelativePath, options);
    });

    await expect(
      publishMemoryHostEventArtifact({
        workspaceRoot,
        owner,
        absolutePath,
        expectedOwnerContent,
        content,
        contentSha256,
      }),
    ).resolves.toBeUndefined();
    expect(foreignBytes.toString("utf8")).toBe(content);
    await expect(fs.readFile(absolutePath)).resolves.toEqual(foreignBytes);
    expect(
      JSON.parse(await fs.readFile(path.join(workspaceDir, ownerRelativePath), "utf8")),
    ).toMatchObject({
      pendingContentSha256: contentSha256,
      fileDev: expect.any(String),
      fileIno: expect.any(String),
    });
  });

  it("finishes an inode-owned empty event export after interruption", async () => {
    const { exportPath, ownerPath, expectedContent } = await interruptedExport(true);
    const listed = await listArtifacts();
    expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(true);
    await expect(fs.readFile(exportPath, "utf8")).resolves.toBe(expectedContent);
    const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    expect(owner).toMatchObject({
      contentSha256: sha256(expectedContent),
      fileDev: expect.any(String),
      fileIno: expect.any(String),
    });
    expect(owner.pendingContentSha256).toBeUndefined();
  });

  it("does not claim an empty export after exclusive-create interruption", async () => {
    const { exportPath } = await interruptedExport(false);
    const listed = await listArtifacts();
    expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(false);
    await expect(fs.readFile(exportPath, "utf8")).resolves.toBe("");
  });
});
