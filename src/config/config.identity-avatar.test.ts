import path from "node:path";
import { expect, it } from "vitest";
import { withTempHome } from "./test-helpers.js";
import { validateConfigObject } from "./validation.js";

it("rejects avatar paths outside the agent workspace", async () => {
  await withTempHome(async (home) => {
    expect(
      validateConfigObject({
        agents: {
          entries: {
            main: {
              default: true,
              workspace: path.join(home, "openclaw"),
              identity: { avatar: "../oops.png" },
            },
          },
        },
      }),
    ).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "agents.entries.main.identity.avatar",
          pathSegments: ["agents", "entries", "main", "identity", "avatar"],
        }),
      ],
    });
  });
});
