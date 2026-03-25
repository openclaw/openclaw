import { describe, expect, it } from "vitest";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway tools.effective", () => {
  it("returns effective tool inventory data", async () => {
    await withServer(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read", "operator.write"] });
      const created = await rpcReq<{ key?: string }>(ws, "sessions.create", {
        label: "Tools Effective Test",
      });
      expect(created.ok).toBe(true);
      const sessionKey = created.payload?.key;
      expect(sessionKey).toBeTruthy();
      const res = await rpcReq<{
        agentId?: string;
        groups?: Array<{
          id?: "core" | "plugin" | "channel";
          source?: "core" | "plugin" | "channel";
          tools?: Array<{ id?: string; source?: "core" | "plugin" | "channel" }>;
        }>;
      }>(ws, "tools.effective", { sessionKey });

      expect(res.ok).toBe(true);
      expect(res.payload?.agentId).toBeTruthy();
      expect((res.payload?.groups ?? []).length).toBeGreaterThan(0);
      expect(
        (res.payload?.groups ?? []).some((group) =>
          (group.tools ?? []).some((tool) => tool.id === "exec"),
        ),
      ).toBe(true);
    });
  });

  it("rejects unknown agent ids", async () => {
    await withServer(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read", "operator.write"] });
      const created = await rpcReq<{ key?: string }>(ws, "sessions.create", {
        label: "Tools Effective Test",
      });
      expect(created.ok).toBe(true);
      const unknownAgent = await rpcReq(ws, "tools.effective", {
        sessionKey: created.payload?.key,
        agentId: "does-not-exist",
      });
      expect(unknownAgent.ok).toBe(false);
      expect(unknownAgent.error?.message ?? "").toContain("unknown agent id");
    });
  });
});
