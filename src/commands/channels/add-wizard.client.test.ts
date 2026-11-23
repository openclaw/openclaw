// A Gateway client hosts targeted channel setup as one dialog, not a prompt per note.
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { createTestConfigSnapshot } from "../test-runtime-config-helpers.js";
import { runChannelsAddWizardFlow } from "./add-wizard.js";

const hoisted = vi.hoisted(() => ({
  persisted: [] as OpenClawConfig[],
  agents: [
    { id: "main", isDefault: true },
    { id: "helper", isDefault: false },
  ],
}));

vi.mock("../../flows/channel-setup.js", () => ({
  createChannelSetupHooks: () => ({ onPostWriteHook: vi.fn(), runPostWriteHooks: vi.fn() }),
  setupChannels: vi.fn(
    async (
      cfg: OpenClawConfig,
      _runtime: unknown,
      _prompter: unknown,
      options: {
        onSelection?: (selection: string[]) => void;
        onAccountId?: (channel: string, accountId: string) => void;
      },
    ) => {
      options.onSelection?.(["whatsapp"]);
      options.onAccountId?.("whatsapp", "default");
      return { ...cfg, channels: { whatsapp: { enabled: true } } };
    },
  ),
}));
vi.mock("../agents.config.js", () => ({
  buildAgentSummaries: vi.fn(async () => hoisted.agents),
}));
vi.mock("./plugin-config-persistence.js", () => ({
  persistChannelPluginConfig: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => {
    hoisted.persisted.push(cfg);
    return { path: "/tmp/openclaw.json" };
  }),
}));

afterEach(() => {
  hoisted.persisted.length = 0;
  vi.clearAllMocks();
});

const runtime = createNonExitingRuntime();

it.each([
  { name: "a Gateway client", clientHosted: true },
  { name: "the terminal", clientHosted: false },
])("routes a targeted channel to the setup agent from $name", async ({ clientHosted }) => {
  const config: OpenClawConfig = {};
  const prompter = createWizardPrompter(
    { confirm: vi.fn(async () => true) },
    { selectValues: ["helper"] },
  );
  const onConfigured = vi.fn();

  await runChannelsAddWizardFlow({
    writeSnapshot: { snapshot: createTestConfigSnapshot(config), writeOptions: {} },
    agentId: "helper",
    runtime,
    prompter,
    initialChannel: "whatsapp",
    deferDeviceLinkToClient: clientHosted,
    onConfigured,
  });

  expect(hoisted.persisted.at(-1)?.bindings).toEqual([
    { agentId: "helper", match: { channel: "whatsapp", accountId: "default" } },
  ]);
  expect(onConfigured).toHaveBeenCalledWith([{ channel: "whatsapp", accountId: "default" }]);
  // The client draws its own title, routing and completion; the terminal still narrates them.
  const steps = [prompter.intro, prompter.outro, prompter.note, prompter.select];
  for (const step of steps) {
    expect(vi.mocked(step).mock.calls.length > 0).toBe(!clientHosted);
  }
});
