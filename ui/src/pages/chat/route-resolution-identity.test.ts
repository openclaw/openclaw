// @vitest-environment node
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { createControlUiSessionFixtures } from "../../test-helpers/control-ui-session-fixtures.ts";
import { loadChatRoute } from "./route-loader.ts";
import {
  createSessionRouteContext as contextFor,
  sessionRouteLocation as targetLocation,
} from "./route-resolution.test-support.ts";

describe("resolved exact session identity", () => {
  it.each(["chat", "dashboard"] as const)(
    "keeps a literal selection reloadable after adopting its %s face",
    async (face) => {
      const selected = {
        key: "agent:main:thread:12345678-aaaa-4000-8000-000000000001",
        boardFace: face,
        displayName: "Shared session title",
      };
      const other = {
        key: "agent:main:thread:12345678-bbbb-4000-8000-000000000002",
        boardFace: face,
        displayName: "Shared session title",
      };
      const fixtures = createControlUiSessionFixtures(
        {
          rows: [selected, other],
          mainKey: "agent:main:main",
        },
        isRecord,
      );
      const createContext = () => {
        const result = contextFor();
        result.request.mockImplementation(async (method, params) => {
          expect(method).toBe("sessions.resolve");
          if (!params || typeof params !== "object") {
            throw new Error("Missing resolution parameters");
          }
          if ("shortId" in params && typeof params.shortId === "string") {
            return fixtures.resolve({ shortId: params.shortId, agentId: "main" });
          }
          expect(params).toMatchObject({ reference: { key: selected.key }, agentId: "main" });
          return fixtures.resolve({ reference: { key: selected.key }, agentId: "main" });
        });
        return result;
      };
      const opened = createContext();
      const target = sessionNavigationTarget({
        context: opened.context,
        face: "chat",
        sessionKey: selected.key,
        preferenceDerivedFace: true,
        exactKey: true,
      });
      expect(target.options.pathname).toBe(
        "/chat/main/thread/12345678-aaaa-4000-8000-000000000001",
      );
      const loaded = await loadChatRoute(
        opened.context,
        targetLocation(target),
        "chat",
        new AbortController().signal,
      );
      expect(loaded).toMatchObject({ kind: "session", sessionKey: selected.key, face });
      if (!("kind" in loaded) || loaded.kind !== "session" || !loaded.canonicalLocation) {
        throw new Error("Expected a canonical session destination");
      }
      // A new connection cannot reuse the first load's in-memory navigation handoff.
      const reloaded = createContext();
      await expect(
        loadChatRoute(
          reloaded.context,
          loaded.canonicalLocation,
          face,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ kind: "session", sessionKey: selected.key, face });
      expect(reloaded.request).toHaveBeenCalledExactlyOnceWith(
        "sessions.resolve",
        expect.objectContaining({ shortId: "12345678aaaa40008000000000000001", agentId: "main" }),
      );
      expect(opened.list).not.toHaveBeenCalled();
      expect(reloaded.list).not.toHaveBeenCalled();
    },
  );
});
