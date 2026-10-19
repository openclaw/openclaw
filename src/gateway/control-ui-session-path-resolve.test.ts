import { parseControlUiSessionPath } from "@openclaw/session-url-contract/parse";
import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveControlUiSessionPath } from "./control-ui-session-path-resolve.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

it("resolves only current public instances before choosing a URL candidate", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:dashboard:12345678-aaaa-4000-8000-000000000001";
    const privateKey = "agent:main:dashboard:12345678-bbbb-4000-8000-000000000002";
    const scope = { agentId: "main", sessionKey: key };
    const grant = { id: "a".repeat(48), sessionId: "generation", createdAt: 1 };
    await upsertSessionEntryCore(scope, {
      sessionId: "generation",
      updatedAt: 1,
      archivedAt: 1,
      displayName: "Public notes",
      publicShare: grant,
    });
    await upsertSessionEntryCore(
      { ...scope, sessionKey: privateKey },
      { sessionId: "private", updatedAt: 2, displayName: "Private title" },
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const resolve = async (path: string) => {
      const target = parseControlUiSessionPath(path);
      if (!target) {
        throw new Error("Invalid fixture URL");
      }
      return resolveControlUiSessionPath({ target, projection, client: null, publicOnly: true });
    };
    try {
      for (const path of [
        "/chat/main/12345678",
        "/chat/main/stale-title-12345678aaaa40008000000000000001",
        "/chat/main/dashboard/12345678-aaaa-4000-8000-000000000001",
        "/chat/main/public-notes",
      ]) {
        expect(await resolve(path)).toMatchObject({ key, agentId: "main" });
      }
      for (const path of [
        "/chat/main/private-title",
        "/chat/main/dashboard/12345678-bbbb-4000-8000-000000000002",
        "/chat/main/absent",
        "/chat/main/incognito/private",
      ]) {
        expect(await resolve(path)).toBeNull();
      }
      await patchSessionEntryCore({ ...scope, sessionKey: privateKey }, () => ({
        displayName: "Public notes",
      }));
      expect(await resolve("/chat/main/public-notes")).toMatchObject({ key });
      const captured = await resolve("/chat/main/12345678");
      await patchSessionEntryCore({ ...scope, sessionKey: privateKey }, () => ({ updatedAt: 3 }));
      await projection.ensureMaterialized();
      expect(captured?.isCurrent()).toBe(true);
      await patchSessionEntryCore({ ...scope, sessionKey: privateKey }, () => ({
        publicShare: { ...grant, id: "c".repeat(48), sessionId: "private" },
      }));
      expect(await resolve("/chat/main/12345678")).toBeNull();
      expect(await resolve("/chat/main/public-notes")).toBeNull();
      expect(captured?.isCurrent()).toBe(false);
      expect(
        await resolve("/chat/main/stale-title-12345678aaaa40008000000000000001"),
      ).toMatchObject({ key });
      await patchSessionEntryCore({ ...scope, sessionKey: privateKey }, () => ({
        publicShare: undefined,
      }));
      await patchSessionEntryCore(scope, () => ({ publicShare: undefined }));
      expect(captured?.isCurrent()).toBe(false);
      expect(await resolve("/chat/main/12345678")).toBeNull();
      await patchSessionEntryCore(scope, () => ({ publicShare: { ...grant, id: "b".repeat(48) } }));
      const republished = await resolve("/chat/main/12345678");
      expect(republished).toMatchObject({ key });
      await patchSessionEntryCore(scope, () => ({ sessionId: "replacement" }));
      expect(republished?.isCurrent()).toBe(false);
      expect(await resolve("/chat/main/12345678")).toBeNull();
    } finally {
      projection.dispose();
    }
  });
});

it("applies current profile access to literal, short, and named session paths", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      ...rolePolicyConfig(),
    };
    setRuntimeConfigSnapshot(cfg);
    const owner = roleClient("none", "path-owner");
    const viewer = roleClient("view", "path-viewer");
    const denied = roleClient("none", "path-denied");
    const key = "agent:main:dashboard:87654321-aaaa-4000-8000-000000000001";
    const scope = { agentId: "main", sessionKey: key };
    await upsertSessionEntryCore(scope, {
      sessionId: "profile-session",
      updatedAt: 1,
      displayName: "Shared notes",
      visibility: "read-only",
      createdActor: {
        type: "human",
        source: "profile",
        id: owner.authenticatedUserProfile!.profileId,
      },
    });
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const resolve = (path: string, client: GatewayClient, isCurrent?: () => boolean) => {
      const target = parseControlUiSessionPath(path);
      if (!target) {
        throw new Error("Invalid fixture URL");
      }
      return resolveControlUiSessionPath({ target, projection, client, isCurrent });
    };
    const paths = [
      "/chat/main/dashboard/87654321-aaaa-4000-8000-000000000001",
      "/chat/main/87654321",
      "/chat/main/shared-notes",
    ];
    try {
      for (const path of paths) {
        expect(await resolve(path, owner)).toMatchObject({ key, agentId: "main" });
        expect(await resolve(path, viewer)).toMatchObject({ key, agentId: "main" });
        expect(await resolve(path, denied)).toBeNull();
      }
      for (const client of [owner, viewer, denied]) {
        expect(await resolve("/chat/main/unknown", client)).toBeNull();
      }
      let authorityCurrent = true;
      const captured = await resolve(paths[0]!, viewer, () => authorityCurrent);
      expect(captured?.isCurrent()).toBe(true);
      authorityCurrent = false;
      expect(captured?.isCurrent()).toBe(false);

      const beforeDraft = await resolve(paths[0]!, viewer);
      await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
      expect(beforeDraft?.isCurrent()).toBe(false);
      for (const path of paths) {
        expect(await resolve(path, owner)).toMatchObject({ key });
        expect(await resolve(path, viewer)).toBeNull();
        expect(await resolve(path, denied)).toBeNull();
      }
    } finally {
      projection.dispose();
    }
  });
});
