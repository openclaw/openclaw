import { beforeEach, expect, test } from "vitest";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../config/io.js";
import { canReadSessionAccess } from "../config/sessions/session-access.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { setupPersistentSessionCreateTestHarness } from "./server.sessions.create.test-support.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { gatewayReplyMock, testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupPersistentSessionCreateTestHarness();
let storePath: string;
beforeEach(async () => {
  ({ storePath } = await createSessionStoreDir());
});
type CreatedSession = { key: string; sessionId: string; entry: SessionEntry; runStarted?: boolean };
const adminClient = () => ({ client: { connect: { scopes: ["operator.admin"] } } as never });
const invalidCreate = (field: string) => ({
  ok: false,
  error: { code: "INVALID_REQUEST", message: `sessions.create ${field} requires a new session` },
});
function createSession(
  params: Record<string, unknown>,
  options?: Parameters<typeof directSessionReq<CreatedSession>>[2],
) {
  return directSessionReq<CreatedSession>(
    "sessions.create",
    { agentId: "main", ...params },
    options,
  );
}
async function seedMain(
  sessionId: string,
  options?: Parameters<typeof sessionStoreEntry>[1],
  key = "main",
) {
  await writeSessionStore({ entries: { [key]: sessionStoreEntry(sessionId, options) } });
}
function readEntry(sessionKey = "agent:main:main") {
  return loadSessionEntry({ agentId: "main", sessionKey, storePath });
}

test.each(["visibility", "access", "unchanged"] as const)(
  "creation rechecks selected sharing policy at writer admission: %s",
  async (change) => {
    const { createGatewaySession } = await import("./session-create-service.js");
    let currentCfg = await captureRuntimeConfigAsyncReader()();
    const cfg = {
      ...currentCfg,
      session: { ...currentCfg.session, sharing: undefined },
    };
    currentCfg = cfg;
    const key = `agent:main:dashboard:commit-sharing-${change}`;
    let admitted = false;
    const creation = createGatewaySession({
      cfg,
      getCurrentConfig: () => currentCfg,
      agentId: "main",
      key,
      commandSource: "test",
      defaultVisibility: change === "visibility" ? "draft" : "shared",
      onPhase(phase) {
        if (phase !== "writerAdmission") {
          return;
        }
        admitted = true;
        currentCfg = {
          ...cfg,
          session: {
            ...cfg.session,
            sharing:
              change === "visibility"
                ? { drafts: false }
                : change === "access"
                  ? { accessPolicy: { default: "creator" } }
                  : undefined,
          },
        };
      },
    });
    if (change === "unchanged") {
      expect(await creation).toMatchObject({ ok: true, entry: { visibility: "shared" } });
      expect(readEntry(key)?.visibility).toBe("shared");
    } else {
      await expect(creation).rejects.toThrow(
        change === "visibility"
          ? "session visibility is disabled"
          : "session creation sharing policy changed",
      );
      expect(readEntry(key)).toBeUndefined();
    }
    expect(admitted).toBe(true);
    expect(gatewayReplyMock).not.toHaveBeenCalled();
  },
);

test("sessions.create stamps source access and preserves explicit Draft choices", async () => {
  testState.sessionConfig = {
    sharing: { accessPolicy: { default: "creator" } },
  };
  const key = "agent:main:dashboard:source-default-private";
  const observed: Array<SessionEntry["access"]> = [];
  const stop = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === key) {
      observed.push(readEntry(key)?.access);
    }
  });
  try {
    const created = await createSession({ key });
    expect(created).toMatchObject({ ok: true, payload: { entry: { access: { mode: "source" } } } });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((access) => access?.mode === "source")).toBe(true);
    const draftKey = "agent:main:dashboard:source-default-explicit-shared";
    expect(await createSession({ key: draftKey, visibility: "draft" })).toMatchObject({
      ok: true,
      payload: { entry: { visibility: "draft", access: { mode: "source" } } },
    });
    expect(await createSession({ key: draftKey })).toMatchObject({
      ok: true,
      payload: { entry: { visibility: "draft", access: { mode: "source" } } },
    });
    expect(await createSession({ key, visibility: "draft" })).toMatchObject(
      invalidCreate("visibility"),
    );
  } finally {
    stop();
    testState.sessionConfig = undefined;
  }
});

test.each(["disabled", "source", "private parent"] as const)(
  "child confidentiality is opt-in for Gateway creation: %s",
  async (mode) => {
    testState.sessionConfig = {
      sharing: mode === "source" ? { accessPolicy: { default: "creator" } } : undefined,
    };
    const configModule = await getGatewayConfigModule();
    configModule.setRuntimeConfigSnapshot(loadGatewayTestConfig());
    try {
      expect(Boolean(getRuntimeConfig().session?.sharing?.accessPolicy)).toBe(mode === "source");
      const parentSessionKey = "agent:main:main";
      await seedMain(
        "child-opt-in-parent",
        {
          visibility: "shared",
          ...(mode === "private parent"
            ? { access: { mode: "audience", profileIds: ["selected"] } }
            : {}),
        },
        parentSessionKey,
      );
      const key = "agent:main:dashboard:opt-in-child";
      const created = await createSession(
        { key, parentSessionKey, visibility: "shared" },
        adminClient(),
      );
      expect(created).toMatchObject({ ok: true });
      const entry = readEntry(key);
      expect(entry).toBeDefined();
      expect(entry?.visibility).toBe("shared");
      expect(entry?.access).toEqual(
        mode === "disabled" ? undefined : { mode: mode === "source" ? "source" : "creator" },
      );
      expect(canReadSessionAccess(getRuntimeConfig(), key, entry!, () => false)).toBe(
        mode === "disabled",
      );
      const overridden = await createSession(
        {
          key: key + "-override",
          parentSessionKey,
          visibility: "shared",
          access: { mode: "unrestricted" },
        },
        adminClient(),
      );
      expect(overridden).toMatchObject({ ok: true });
      expect(readEntry(key + "-override")?.access).toEqual({ mode: "unrestricted" });
    } finally {
      testState.sessionConfig = undefined;
      configModule.clearRuntimeConfigSnapshot();
    }
  },
);

test("keeps an implicit Draft-parent fork confidential after copying its transcript", async () => {
  testState.sessionConfig = { sharing: undefined };
  const configModule = await getGatewayConfigModule();
  configModule.setRuntimeConfigSnapshot(loadGatewayTestConfig());
  try {
    expect(getRuntimeConfig().session?.sharing?.accessPolicy).toBeUndefined();
    const parentSessionKey = "agent:main:main";
    await seedMain("draft-fork-parent", { visibility: "draft" }, parentSessionKey);
    await appendTranscriptMessage(
      { agentId: "main", sessionKey: parentSessionKey, sessionId: "draft-fork-parent", storePath },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "private draft fork context" }],
        },
      },
    );
    const key = "agent:main:dashboard:private-draft-fork";
    const created = await createSession({ key, parentSessionKey, fork: true }, adminClient());
    expect(created).toMatchObject({ ok: true });
    const entry = readEntry(key);
    expect(entry).toBeDefined();
    expect(entry?.access).toEqual({ mode: "creator" });
    expect(
      JSON.stringify(
        loadTranscriptEventsSync({
          agentId: "main",
          sessionKey: key,
          sessionId: entry!.sessionId,
          storePath,
        }),
      ),
    ).toContain("private draft fork context");
    expect(canReadSessionAccess(getRuntimeConfig(), key, entry!, () => false)).toBe(false);
  } finally {
    testState.sessionConfig = undefined;
    configModule.clearRuntimeConfigSnapshot();
  }
});
