// @vitest-environment node
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  SESSION_NAVIGATION_KEY_PARAM,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { createControlUiSessionFixtures } from "../../test-helpers/control-ui-session-fixtures.ts";
import {
  canonicalSession,
  createSessionRouteContext as contextFor,
  loadSessionRoute as load,
  sessionRouteLocation as targetLocation,
} from "./route-resolution.test-support.ts";

describe("resolved exact session identity", () => {
  it("clears a retained Incognito navigation hint without changing its exact identity or draft", async () => {
    const { context, request, list } = contextFor();
    const sessionKey = "agent:main:dashboard:incognito-12345678-aaaa-4000-8000-000000000001";
    const location = {
      pathname: "/chat/main/dashboard/incognito-12345678-aaaa-4000-8000-000000000001",
      search: `?${new URLSearchParams({
        [SESSION_NAVIGATION_KEY_PARAM]: sessionKey,
        draft: "Continue this conversation",
        dashboard: "expanded",
      })}`,
      hash: "",
    };
    const loaded = await load(context, location);
    expect(loaded).toMatchObject({
      kind: "session",
      sessionKey,
      draft: "Continue this conversation",
      dashboardExpanded: true,
      canonicalLocation: {
        ...location,
        search: "?draft=Continue+this+conversation&dashboard=expanded",
      },
      canonicalLocationSource: location,
    });
    expect(request).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["chat", "dashboard"] as const)(
    "keeps a literal selection reloadable after adopting its %s face",
    async (face) => {
      const session = (suffix: string) => ({
        key: `agent:main:thread:12345678-${suffix}`,
        boardFace: face,
        displayName: "Shared session title",
      });
      const selected = session("aaaa-4000-8000-000000000001");
      const fixtures = createControlUiSessionFixtures(
        {
          rows: [selected, session("bbbb-4000-8000-000000000002")],
          mainKey: "agent:main:main",
        },
        isRecord,
      );
      const createContext = () => {
        const result = contextFor();
        result.request.mockImplementation(async (method, params) => {
          expect(method).toBe("sessions.resolve");
          if (!isRecord(params)) {
            throw new Error("Missing resolution parameters");
          }
          if (typeof params.shortId === "string") {
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
      const loaded = canonicalSession(await load(opened.context, targetLocation(target)));
      expect(loaded).toMatchObject({ kind: "session", sessionKey: selected.key, face });
      // A new connection cannot reuse the first load's in-memory navigation handoff.
      const reloaded = createContext();
      await expect(load(reloaded.context, loaded.canonicalLocation, face)).resolves.toMatchObject({
        kind: "session",
        sessionKey: selected.key,
        face,
      });
      expect(reloaded.request).toHaveBeenCalledExactlyOnceWith(
        "sessions.resolve",
        expect.objectContaining({ shortId: "12345678aaaa40008000000000000001", agentId: "main" }),
      );
      expect([opened.list.mock.calls, reloaded.list.mock.calls]).toEqual([[], []]);
    },
  );
});
