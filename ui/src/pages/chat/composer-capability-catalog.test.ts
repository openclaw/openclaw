import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ComposerSkillCatalog } from "./composer-capability-catalog.ts";

it("keeps late skill results scoped to their session on the same agent", async () => {
  const first = createDeferred<unknown>();
  const second = createDeferred<unknown>();
  const firstLoaded = createDeferred();
  const secondLoaded = createDeferred();
  const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const client = { request } as unknown as GatewayBrowserClient;
  const catalog = new ComposerSkillCatalog(() => {
    if (catalog.rows("main", null, "first")) {
      firstLoaded.resolve();
    }
    if (catalog.rows("main", null, "second")) {
      secondLoaded.resolve();
    }
  });
  const skillReport = (name: string) => ({
    skills: [
      {
        name,
        skillKey: name,
        disabled: false,
        blockedByAllowlist: false,
        missing: { bins: [], env: [], config: [], os: [] },
      },
    ],
  });
  catalog.load(client, 1, "main", () => true, "first");
  catalog.load(client, 1, "main", () => true, "second");
  expect(request.mock.calls).toEqual([
    ["skills.status", { agentId: "main", sessionKey: "first" }],
    ["skills.status", { agentId: "main", sessionKey: "second" }],
  ]);
  second.resolve(skillReport("second-project"));
  await secondLoaded.promise;
  expect(catalog.rows("main", null, "first")).toBeNull();
  first.resolve(skillReport("first-project"));
  await firstLoaded.promise;
  expect(catalog.rows("main", null, "second")?.map((skill) => skill.name)).toEqual([
    "second-project",
  ]);
  expect(catalog.rows("main", null, "first")?.map((skill) => skill.name)).toEqual([
    "first-project",
  ]);
  expect(catalog.rows("main", null)).toBeNull();
});
