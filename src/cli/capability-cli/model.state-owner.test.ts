import { Command } from "commander";
import { beforeEach, expect, it } from "vitest";
import { useLocalStateOwnerFixture } from "../local-state-owner.fixture.test-support.js";
import { registerModelCapabilityCommands } from "./model.js";

const fixture = useLocalStateOwnerFixture();
beforeEach(async () => {
  await fixture.startOwner();
});

it("refuses infer model auth logout while the Gateway owns the shared credentials", async () => {
  const command = new Command();
  registerModelCapabilityCommands(command);
  await expect(
    command.parseAsync(["model", "auth", "logout", "--provider", "fixture", "--json"], {
      from: "user",
    }),
  ).rejects.toMatchObject({
    code: "OWNER_UNAVAILABLE",
    message: expect.stringContaining("This command is offline-only."),
  });
  expect(fixture.transport.request).not.toHaveBeenCalled();
});
