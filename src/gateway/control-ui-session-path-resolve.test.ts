import { parseControlUiSessionPath } from "@openclaw/session-url-contract/parse";
import { afterEach, expect, it } from "vitest";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveControlUiSessionPath } from "./control-ui-session-path-resolve.js";
import { createSessionRowProjection } from "./session-row-projection.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

it("resolves only current public instances before choosing a URL candidate", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const key = "agent:main:dashboard:12345678-aaaa-4000-8000-000000000001";
    const privateKey = "agent:main:dashboard:12345678-bbbb-4000-8000-000000000002";
    const scope = { agentId: "main", sessionKey: key };
    const grant = { id: "a".repeat(48), sessionId: "generation", createdAt: 1 };
    await upsertSessionEntryCore(scope, {
      sessionId: "generation",
      updatedAt: 1,
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
      const captured = await resolve("/chat/main/12345678");
      await patchSessionEntryCore(scope, () => ({ publicShare: undefined }));
      expect(captured?.isCurrent()).toBe(false);
      expect(await resolve("/chat/main/12345678")).toBeNull();
      await patchSessionEntryCore(scope, () => ({ publicShare: { ...grant, id: "b".repeat(48) } }));
      expect(await resolve("/chat/main/12345678")).toMatchObject({ key });
      await patchSessionEntryCore(scope, () => ({ sessionId: "replacement" }));
      expect(await resolve("/chat/main/12345678")).toBeNull();
    } finally {
      projection.dispose();
    }
  });
});
