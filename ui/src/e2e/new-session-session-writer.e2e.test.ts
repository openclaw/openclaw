import { expect, it } from "vitest";
import { openFromForeground, scenario } from "./command-palette.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  captureUiProof,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
suite.define(() => {
  it.each(["page", "palette"] as const)(
    "starts an ordinary session from %s with only the session-write grant",
    async (surface) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const base = scenario();
        const gateway = await installMockGateway(page, {
          ...base,
          operatorScopes: ["operator.sessions.write"],
          methodResponses: {
            ...base.methodResponses,
            "agents.list": {
              ...(base.methodResponses!["agents.list"] as object),
              sessionPlacement: {},
            },
            "environments.list": {
              __mockError: { code: "FORBIDDEN", message: "missing scope: operator.write" },
            },
            "sessions.create": { key: "agent:main:session-writer-created", runStarted: true },
          },
        });
        let submit;
        if (surface === "page") {
          await page.goto(suite.server.baseUrl + "new");
          await page.locator(".new-session-page__message").fill("Inspect my workspace");
          submit = page.getByRole("button", { name: "Start session", exact: true });
        } else {
          const { input, palette } = await openFromForeground(page, suite.server.baseUrl);
          await input.fill("Inspect my workspace");
          submit = palette.locator(".cmd-palette__create");
        }
        try {
          await expect.poll(() => submit.isEnabled()).toBe(true);
        } finally {
          await captureUiProof(suite, page, "session-writer-" + surface + ".png");
        }
        expect(await gateway.getRequests("environments.list")).toHaveLength(0);
        await submit.click();
        await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
          params: { message: "Inspect my workspace" },
        });
      });
    },
  );
});
