import { parseControlUiSessionPath } from "@openclaw/session-url-contract/parse";
import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveControlUiSessionPath } from "./control-ui-session-path-resolve.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

const scope = (sessionKey: string) => ({ agentId: "main", sessionKey });
const patch = (key: string, changes: Partial<InternalSessionEntry>) =>
  patchSessionEntryCore(scope(key), () => changes);
const put = (key: string, sessionId: string, fields: Partial<InternalSessionEntry>) =>
  upsertSessionEntryCore(scope(key), { sessionId, updatedAt: 1, ...fields });
const config = (): OpenClawConfig => ({ agents: { entries: { main: {} } } });
function resolver(projection: SessionRowProjection, publicOnly = false) {
  return (ref: string, client: GatewayClient | null = null, isCurrent?: () => boolean) => {
    const target = parseControlUiSessionPath(`/chat/main/${ref}`);
    if (!target) {
      throw new Error("Invalid fixture URL");
    }
    return resolveControlUiSessionPath({ target, projection, client, publicOnly, isCurrent });
  };
}

it("resolves only current public instances before choosing a URL candidate", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:dashboard:12345678-aaaa-4000-8000-000000000001";
    const privateKey = "agent:main:dashboard:12345678-bbbb-4000-8000-000000000002";
    const grant = { id: "a".repeat(48), sessionId: "generation", createdAt: 1 };
    await put(key, "generation", {
      archivedAt: 1,
      displayName: "Public notes",
      publicShare: grant,
    });
    await put(privateKey, "private", { updatedAt: 2, displayName: "Private title" });
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const resolve = resolver(projection, true);
    try {
      for (const path of [
        "12345678",
        "stale-title-12345678aaaa40008000000000000001",
        "dashboard/12345678-aaaa-4000-8000-000000000001",
        "public-notes",
      ]) {
        expect(await resolve(path)).toMatchObject({ key, agentId: "main" });
      }
      for (const path of [
        "private-title",
        "dashboard/12345678-bbbb-4000-8000-000000000002",
        "absent",
        "incognito/private",
      ]) {
        expect(await resolve(path)).toBeNull();
      }
      await patch(privateKey, { displayName: "Public notes" });
      expect(await resolve("public-notes")).toMatchObject({ key });
      const captured = await resolve("12345678");
      await patch(privateKey, { updatedAt: 3 });
      await projection.ensureMaterialized();
      expect(captured?.isCurrent()).toBe(true);
      await patch(privateKey, {
        publicShare: { ...grant, id: "c".repeat(48), sessionId: "private" },
      });
      expect(await resolve("12345678")).toBeNull();
      expect(await resolve("public-notes")).toBeNull();
      expect(captured?.isCurrent()).toBe(false);
      expect(await resolve("stale-title-12345678aaaa40008000000000000001")).toMatchObject({ key });
      await patch(privateKey, { publicShare: undefined });
      await patch(key, { publicShare: undefined });
      expect(captured?.isCurrent()).toBe(false);
      expect(await resolve("12345678")).toBeNull();
      await patch(key, { publicShare: { ...grant, id: "b".repeat(48) } });
      const republished = await resolve("12345678");
      expect(republished).toMatchObject({ key });
      await patch(key, { sessionId: "replacement" });
      expect(republished?.isCurrent()).toBe(false);
      expect(await resolve("12345678")).toBeNull();
    } finally {
      projection.dispose();
    }
  });
});

it("applies current profile access to literal, short, and named session paths", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg: OpenClawConfig = { ...config(), ...rolePolicyConfig() };
    setRuntimeConfigSnapshot(cfg);
    const owner = roleClient("none", "path-owner");
    const viewer = roleClient("view", "path-viewer");
    const denied = roleClient("none", "path-denied");
    const key = "agent:main:dashboard:87654321-aaaa-4000-8000-000000000001";
    await put(key, "profile-session", {
      displayName: "Shared notes",
      visibility: "read-only",
      createdActor: {
        type: "human",
        source: "profile",
        id: owner.authenticatedUserProfile!.profileId,
      },
    });
    const paths = ["dashboard/87654321-aaaa-4000-8000-000000000001", "87654321", "shared-notes"];
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const resolve = resolver(projection);
    try {
      for (const path of paths) {
        expect(await resolve(path, owner)).toMatchObject({ key, agentId: "main" });
        expect(await resolve(path, viewer)).toMatchObject({ key, agentId: "main" });
        expect(await resolve(path, denied)).toBeNull();
      }
      for (const client of [owner, viewer, denied]) {
        expect(await resolve("unknown", client)).toBeNull();
      }
      let authorityCurrent = true;
      const captured = await resolve(paths[0]!, viewer, () => authorityCurrent);
      expect(captured?.isCurrent()).toBe(true);
      authorityCurrent = false;
      expect(captured?.isCurrent()).toBe(false);

      const beforeDraft = await resolve(paths[0]!, viewer);
      await patch(key, { visibility: "draft" });
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
