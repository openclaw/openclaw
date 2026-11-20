/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { createContext } from "../system-history/test-support.ts";
import { page } from "./route.tsx";
it.each(["", "?onboarding=1", "?intent=new-agent"])(
  "redirects the old URL without starting setup or creating an agent: %s",
  async (search) => {
    const request = vi.fn();
    const { context } = createContext(request);
    const result = await page.loader!(
      context,
      createRouteLoaderOptions({ pathname: "/custodian", search, hash: "" }, search),
    );
    expect(JSON.stringify(result)).toContain("/chat");
    expect(request).not.toHaveBeenCalled();
  },
);
it("sends an unconfigured administrator to Connect AI", async () => {
  const { context } = createContext(vi.fn(), [], {
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    },
  });
  const result = await page.loader!(
    context,
    createRouteLoaderOptions({ pathname: "/custodian", search: "?intent=new-agent", hash: "" }, ""),
  );
  expect(JSON.stringify(result)).toContain("/settings/model-setup");
});
