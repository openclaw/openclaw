import { expect, it } from "vitest";
import { createSessionsSpawnToolSchema } from "./sessions-spawn-tool.schema.js";

it("distinguishes cwd binding from inherited roots in the advertised spawn contract", () => {
  const schema = createSessionsSpawnToolSchema({
    acpAvailable: false,
    threadAvailable: false,
    subagentThreadAvailable: false,
    swarmEnabled: false,
  });
  expect(schema).toMatchObject({
    properties: {
      cwd: {
        description: expect.stringMatching(
          /configuration-only.*cwd.*explicit restricted permission.*inherited recorded root.*Required roots.*sender.*sandbox/,
        ),
      },
    },
  });
});
