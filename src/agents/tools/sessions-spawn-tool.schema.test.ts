import { expect, it } from "vitest";
import { createSessionsSpawnToolSchema } from "./sessions-spawn-tool.schema.js";
import { validateVisibleSpawnOptions } from "./sessions-spawn-visible.schema.js";
import { ToolInputError } from "./common.js";

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
      attachmentRefs: {
        type: "array",
        maxItems: 50,
      },
    },
  });
});

it("rejects host-managed attachments on visible sessions", () => {
  expect(() =>
    validateVisibleSpawnOptions(
      { visible: true, attachmentRefs: [{ id: "image" }] },
      "subagent",
    ),
  ).toThrow(ToolInputError);
});
