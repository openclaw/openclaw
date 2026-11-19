import { expect } from "vitest";
import type { GatewayClient } from "./client.js";

export async function expectNonAdminMemberProfileActions(
  client: Pick<GatewayClient, "request">,
  actions: ReadonlyArray<readonly [string, object]>,
  profileId: string,
): Promise<void> {
  for (const [method, params] of actions) {
    if (method === "users.personalFile.get") {
      await expect(client.request(method, params)).resolves.toMatchObject({
        agentId: "main",
        profileId,
      });
    } else if (method === "mentions.list") {
      await expect(client.request(method, params)).resolves.toEqual({
        gatewayInstanceId: expect.any(String),
        items: [],
        revision: 0,
      });
    } else {
      await expect(client.request(method, params), method).rejects.toThrow();
    }
  }
}
