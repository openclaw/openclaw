import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import { listMemoryArtifactProvenance } from "../../../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../../../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../../../test-helpers/state-dir-env.js";
import { createInternalHookEvent } from "../../internal-hooks.js";
import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

type ProvenanceRecordObservation = {
  relativePath: string;
  originClass: "agent" | "untrusted";
  destinationExists: boolean;
  markdownFilesPresent: string[];
};

const provenanceObservations = vi.hoisted(() => ({
  records: [] as ProvenanceRecordObservation[],
}));

const claimBarrier = vi.hoisted(() => ({
  contenders: 0,
  relativePath: undefined as string | undefined,
  arrived: 0,
  pending: undefined as Promise<void> | undefined,
  release: undefined as (() => void) | undefined,
}));

const awaitClaimBarrier = vi.hoisted(() => async (relativePath: string): Promise<void> => {
  if (claimBarrier.contenders <= 0) {
    return;
  }
  claimBarrier.relativePath ??= relativePath;
  if (claimBarrier.relativePath !== relativePath) {
    return;
  }
  claimBarrier.pending ??= new Promise<void>((resolve) => {
    claimBarrier.release = resolve;
  });
  claimBarrier.arrived += 1;
  if (claimBarrier.arrived >= claimBarrier.contenders) {
    claimBarrier.release?.();
  }
  await claimBarrier.pending;
});

vi.mock("../../../memory/memory-artifact-provenance.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../memory/memory-artifact-provenance.js")>();
  const nodeFs = await import("node:fs/promises");
  const nodePath = await import("node:path");
  return {
    ...actual,
    claimMemoryArtifactCreateProvenance: async (
      params: Parameters<typeof actual.claimMemoryArtifactCreateProvenance>[0],
    ) => {
      const destination = nodePath.default.join(params.workspaceDir, params.relativePath);
      await awaitClaimBarrier(params.relativePath);
      const claim = await actual.claimMemoryArtifactCreateProvenance(params);
      if (claim.status !== "claimed") {
        return claim;
      }
      provenanceObservations.records.push({
        relativePath: params.relativePath,
        originClass: params.originClass,
        destinationExists: await nodeFs.default
          .lstat(destination)
          .then(() => true)
          .catch(() => false),
        markdownFilesPresent: await nodeFs.default
          .readdir(nodePath.default.dirname(destination))
          .then((entries) => entries.filter((entry) => entry.endsWith(".md")).sort())
          .catch(() => []),
      });
      return claim;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session-memory automatic reset", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-session-memory-auto-");
    provenanceObservations.records.length = 0;
    claimBarrier.contenders = 0;
    claimBarrier.relativePath = undefined;
    claimBarrier.arrived = 0;
    claimBarrier.pending = undefined;
    claimBarrier.release = undefined;
  });

  afterEach(async () => {
    await flushSessionMemoryWritesForTest();
    resetPluginStateStoreForTests();
  });

  const rolloverAt = new Date("2026-03-04T05:06:07.000Z");

  function makeConfig(storePath: string): OpenClawConfig {
    return {
      agents: { defaults: { workspace: tempDir } },
      session: { store: storePath },
    } satisfies OpenClawConfig;
  }

  async function storeRolloverTranscript(params: {
    storePath: string;
    sessionId: string;
    sessionKey: string;
    marker: string;
    senderIsOwner?: boolean;
  }): Promise<void> {
    await replaceTranscriptEvents(
      {
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      [
        {
          type: "message",
          id: `${params.sessionId}-user`,
          parentId: null,
          message: {
            role: "user",
            content: `Remember ${params.marker}`,
            __openclaw: { senderIsOwner: params.senderIsOwner ?? true },
          },
        },
        {
          type: "message",
          id: `${params.sessionId}-assistant`,
          parentId: `${params.sessionId}-user`,
          message: { role: "assistant", content: "Captured automatically" },
        },
      ],
    );
  }

  function buildRolloverEvent(params: {
    cfg: OpenClawConfig;
    storePath: string;
    sessionId: string;
    sessionKey: string;
  }) {
    return {
      ...createInternalHookEvent("session", "auto-reset", params.sessionKey, {
        cfg: params.cfg,
        agentId: "main",
        workspaceDir: tempDir,
        storePath: params.storePath,
        sessionEntry: { sessionId: params.sessionId },
        reason: "daily",
      }),
      timestamp: rolloverAt,
    };
  }

  async function runRollover(params: {
    storePath: string;
    sessionId: string;
    sessionKey: string;
    marker: string;
    senderIsOwner?: boolean;
  }): Promise<void> {
    await storeRolloverTranscript(params);
    await handler(
      buildRolloverEvent({
        cfg: makeConfig(params.storePath),
        storePath: params.storePath,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      }),
    );
  }

  async function resolveCapturedBasename(memoryDir: string): Promise<string> {
    const files = await fs.readdir(memoryDir);
    return expectDefined(files[0], "files[0] test invariant").replace(/\.md$/u, "");
  }

  it.each(["daily", "idle"] as const)(
    "creates memory from the ended session on %s reset",
    async (reason) => {
      const sessionKey = "agent:main:main";
      const sessionId = `${reason}-session`;
      const storePath = path.join(tempDir, "sessions.json");
      const cfg = {
        agents: { defaults: { workspace: tempDir } },
        session: { store: storePath },
      } satisfies OpenClawConfig;
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        {
          type: "message",
          id: `${reason}-user`,
          parentId: null,
          message: {
            role: "user",
            content: `Remember the ${reason} rollover`,
            __openclaw: { senderIsOwner: true },
          },
        },
        {
          type: "message",
          id: `${reason}-assistant`,
          parentId: `${reason}-user`,
          message: { role: "assistant", content: "Captured automatically" },
        },
      ]);
      const event = createInternalHookEvent("session", "auto-reset", sessionKey, {
        cfg,
        agentId: "main",
        workspaceDir: tempDir,
        storePath,
        sessionEntry: { sessionId },
        reason,
      });

      const completed = handler(event);
      expect(completed).toBeInstanceOf(Promise);
      await completed;

      const memoryDir = path.join(tempDir, "memory");
      const files = await fs.readdir(memoryDir);
      const memoryContent = await fs.readFile(
        path.join(memoryDir, expectDefined(files[0], "files[0] test invariant")),
        "utf8",
      );
      expect(files).toHaveLength(1);
      expect(memoryContent).toContain(`- **Reason**: ${reason}`);
      expect(memoryContent).toContain(`user: ${JSON.stringify(`Remember the ${reason} rollover`)}`);
      expect(memoryContent).toContain(`assistant: ${JSON.stringify("Captured automatically")}`);
    },
  );

  it("keeps both rollovers when two sessions reset in the same minute", async () => {
    const storePath = path.join(tempDir, "sessions.json");
    const cfg = {
      agents: { defaults: { workspace: tempDir } },
      session: { store: storePath },
    } satisfies OpenClawConfig;
    const sessions = [
      { sessionKey: "agent:main:chat-alpha", sessionId: "alpha-session", marker: "ALPHA-ONLY" },
      { sessionKey: "agent:main:chat-beta", sessionId: "beta-session", marker: "BETA-ONLY" },
    ];

    for (const session of sessions) {
      await replaceTranscriptEvents(
        {
          agentId: "main",
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
          storePath,
        },
        [
          {
            type: "message",
            id: `${session.sessionId}-user`,
            parentId: null,
            message: {
              role: "user",
              content: `Remember ${session.marker}`,
              __openclaw: { senderIsOwner: true },
            },
          },
          {
            type: "message",
            id: `${session.sessionId}-assistant`,
            parentId: `${session.sessionId}-user`,
            message: { role: "assistant", content: "Captured automatically" },
          },
        ],
      );
    }

    const events = sessions.map((session) => ({
      ...createInternalHookEvent("session", "auto-reset", session.sessionKey, {
        cfg,
        agentId: "main",
        workspaceDir: tempDir,
        storePath,
        sessionEntry: { sessionId: session.sessionId },
        reason: "daily",
      }),
      timestamp: rolloverAt,
    }));

    await Promise.all(events.map((event) => handler(event)));

    const memoryDir = path.join(tempDir, "memory");
    const files = (await fs.readdir(memoryDir)).sort();
    expect(files).toHaveLength(2);
    const contents = await Promise.all(
      files.map(async (file) => await fs.readFile(path.join(memoryDir, file), "utf8")),
    );
    for (const session of sessions) {
      expect(
        contents.filter((content) => content.includes(`Remember ${session.marker}`)),
      ).toHaveLength(1);
    }
  });

  it("keeps the capture when every numbered filename is already occupied", async () => {
    const storePath = path.join(tempDir, "sessions.json");
    await runRollover({
      storePath,
      sessionId: "first-session",
      sessionKey: "agent:main:chat-first",
      marker: "FIRST-ONLY",
    });

    const memoryDir = path.join(tempDir, "memory");
    const basename = await resolveCapturedBasename(memoryDir);
    for (let suffix = 2; suffix <= 64; suffix += 1) {
      await fs.writeFile(path.join(memoryDir, `${basename}-${suffix}.md`), "occupied", "utf8");
    }

    await runRollover({
      storePath,
      sessionId: "late-session",
      sessionKey: "agent:main:chat-late",
      marker: "LATE-ONLY",
    });

    const files = await fs.readdir(memoryDir);
    expect(files).toHaveLength(65);
    const contents = await Promise.all(
      files.map(async (file) => await fs.readFile(path.join(memoryDir, file), "utf8")),
    );
    expect(contents.filter((content) => content.includes("Remember LATE-ONLY"))).toHaveLength(1);
  });

  it("skips occupied candidates that are not regular files", async () => {
    const storePath = path.join(tempDir, "sessions.json");
    await runRollover({
      storePath,
      sessionId: "first-session",
      sessionKey: "agent:main:chat-first",
      marker: "FIRST-ONLY",
    });

    const memoryDir = path.join(tempDir, "memory");
    const basename = await resolveCapturedBasename(memoryDir);
    await fs.mkdir(path.join(memoryDir, `${basename}-2.md`));
    await fs.link(path.join(memoryDir, `${basename}.md`), path.join(memoryDir, `${basename}-3.md`));

    await runRollover({
      storePath,
      sessionId: "late-session",
      sessionKey: "agent:main:chat-late",
      marker: "LATE-ONLY",
    });

    const captured = await fs.readFile(path.join(memoryDir, `${basename}-4.md`), "utf8");
    expect(captured).toContain("Remember LATE-ONLY");
  });

  it("preserves provenance of an occupied artifact when concurrent rollovers lose the claim", async () => {
    await withStateDirEnv("openclaw-session-memory-provenance-", async () => {
      const storePath = path.join(tempDir, "sessions.json");
      await runRollover({
        storePath,
        sessionId: "origin-session",
        sessionKey: "agent:main:chat-origin",
        marker: "ORIGIN-ONLY",
      });

      const memoryDir = path.join(tempDir, "memory");
      const basename = await resolveCapturedBasename(memoryDir);
      const occupied = `${basename}.md`;
      const readProvenance = async () => {
        const entries = await listMemoryArtifactProvenance({ workspaceDir: tempDir });
        return entries.find((entry) => entry.relativePath.endsWith(occupied))?.provenance;
      };
      const before = expectDefined(await readProvenance(), "origin provenance test invariant");
      expect(before.sessionId).toBe("origin-session");

      const losers = [
        { sessionId: "alpha-session", sessionKey: "agent:main:chat-alpha", marker: "ALPHA-ONLY" },
        { sessionId: "beta-session", sessionKey: "agent:main:chat-beta", marker: "BETA-ONLY" },
      ];
      for (const loser of losers) {
        await storeRolloverTranscript({ storePath, ...loser });
      }
      await Promise.all(
        losers.map(async (loser) =>
          handler(
            buildRolloverEvent({
              cfg: makeConfig(storePath),
              storePath,
              sessionId: loser.sessionId,
              sessionKey: loser.sessionKey,
            }),
          ),
        ),
      );

      expect(await readProvenance()).toEqual(before);
      expect(await fs.readFile(path.join(memoryDir, occupied), "utf8")).toContain(
        "Remember ORIGIN-ONLY",
      );
      expect(await fs.readdir(memoryDir)).toHaveLength(3);
    });
  });

  it.each([
    {
      name: "owner capture",
      senderIsOwner: true,
      marker: "OWNER-ONLY",
      expectedOrigin: "agent",
    },
    {
      name: "non-owner capture",
      senderIsOwner: false,
      marker: "NON-OWNER-ONLY",
      expectedOrigin: "untrusted",
    },
  ] as const)("publishes a $name without exposing an untracked memory path", async (testCase) => {
    await withStateDirEnv("openclaw-session-memory-window-", async () => {
      const storePath = path.join(tempDir, "sessions.json");
      await runRollover({
        storePath,
        sessionId: `${testCase.expectedOrigin}-session`,
        sessionKey: `agent:main:chat-${testCase.expectedOrigin}`,
        marker: testCase.marker,
        senderIsOwner: testCase.senderIsOwner,
      });

      const memoryDir = path.join(tempDir, "memory");
      const files = await fs.readdir(memoryDir);
      const filename = expectDefined(files[0], "session memory file test invariant");
      expect(files).toHaveLength(1);
      expect(provenanceObservations.records).toEqual([
        {
          relativePath: `memory/${filename}`,
          originClass: testCase.expectedOrigin,
          destinationExists: false,
          markdownFilesPresent: [],
        },
      ]);

      const entries = await listMemoryArtifactProvenance({ workspaceDir: tempDir });
      expect(entries).toEqual([
        {
          relativePath: `memory/${filename}`,
          provenance: expect.objectContaining({ originClass: testCase.expectedOrigin }),
        },
      ]);
      expect(await fs.readFile(path.join(memoryDir, filename), "utf8")).toContain(
        `Remember ${testCase.marker}`,
      );
    });
  });

  it("keeps each provenance record with its own capture when three claims overlap", async () => {
    await withStateDirEnv("openclaw-session-memory-three-way-", async () => {
      const storePath = path.join(tempDir, "sessions.json");
      const contenders = [
        {
          sessionId: "alpha-session",
          sessionKey: "agent:main:chat-alpha",
          marker: "ALPHA-ONLY",
          senderIsOwner: true,
          expectedOrigin: "agent" as const,
        },
        {
          sessionId: "beta-session",
          sessionKey: "agent:main:chat-beta",
          marker: "BETA-ONLY",
          senderIsOwner: false,
          expectedOrigin: "untrusted" as const,
        },
        {
          sessionId: "gamma-session",
          sessionKey: "agent:main:chat-gamma",
          marker: "GAMMA-ONLY",
          senderIsOwner: true,
          expectedOrigin: "agent" as const,
        },
      ];
      for (const contender of contenders) {
        await storeRolloverTranscript({ storePath, ...contender });
      }

      claimBarrier.contenders = contenders.length;
      await Promise.all(
        contenders.map(async (contender) =>
          handler(
            buildRolloverEvent({
              cfg: makeConfig(storePath),
              storePath,
              sessionId: contender.sessionId,
              sessionKey: contender.sessionKey,
            }),
          ),
        ),
      );

      const memoryDir = path.join(tempDir, "memory");
      expect(await fs.readdir(memoryDir)).toHaveLength(contenders.length);
      expect(provenanceObservations.records).toHaveLength(contenders.length);
      expect(provenanceObservations.records.map((record) => record.destinationExists)).toEqual([
        false,
        false,
        false,
      ]);

      const entries = await listMemoryArtifactProvenance({ workspaceDir: tempDir });
      expect(entries).toHaveLength(contenders.length);
      const observed = await Promise.all(
        entries.map(async (entry) => {
          const content = await fs.readFile(path.join(tempDir, entry.relativePath), "utf8");
          const owner = expectDefined(
            contenders.find((contender) => content.includes(`Remember ${contender.marker}`)),
            "capture owner test invariant",
          );
          return {
            marker: owner.marker,
            sessionId: entry.provenance.sessionId,
            sessionKey: entry.provenance.sessionKey,
            originClass: entry.provenance.originClass,
            hashMatchesContent:
              entry.provenance.fileHash === createHash("sha256").update(content).digest("hex"),
          };
        }),
      );
      expect(observed.sort((left, right) => left.marker.localeCompare(right.marker))).toEqual(
        contenders
          .map((contender) => ({
            marker: contender.marker,
            sessionId: contender.sessionId,
            sessionKey: contender.sessionKey,
            originClass: contender.expectedOrigin,
            hashMatchesContent: true,
          }))
          .sort((left, right) => left.marker.localeCompare(right.marker)),
      );
    });
  });

  it("retains untrusted classification when a non-owner capture follows an owner capture", async () => {
    await withStateDirEnv("openclaw-session-memory-interleave-", async () => {
      const storePath = path.join(tempDir, "sessions.json");
      await runRollover({
        storePath,
        sessionId: "owner-session",
        sessionKey: "agent:main:chat-owner",
        marker: "OWNER-FIRST",
        senderIsOwner: true,
      });
      await runRollover({
        storePath,
        sessionId: "intruder-session",
        sessionKey: "agent:main:chat-intruder",
        marker: "INTRUDER-SECOND",
        senderIsOwner: false,
      });

      const memoryDir = path.join(tempDir, "memory");
      expect(provenanceObservations.records.map((record) => record.destinationExists)).toEqual([
        false,
        false,
      ]);
      const entries = (await listMemoryArtifactProvenance({ workspaceDir: tempDir })).sort(
        (left, right) => left.relativePath.localeCompare(right.relativePath),
      );
      const classified = await Promise.all(
        entries.map(async (entry) => ({
          originClass: entry.provenance.originClass,
          marker: (await fs.readFile(path.join(tempDir, entry.relativePath), "utf8")).includes(
            "Remember OWNER-FIRST",
          )
            ? "OWNER-FIRST"
            : "INTRUDER-SECOND",
        })),
      );
      expect(classified).toEqual(
        expect.arrayContaining([
          { originClass: "agent", marker: "OWNER-FIRST" },
          { originClass: "untrusted", marker: "INTRUDER-SECOND" },
        ]),
      );
      expect(await fs.readdir(memoryDir)).toHaveLength(2);
    });
  });
});
