import { runInteractiveOnboarding } from "../commands/onboard-interactive-runner.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "./clack-prompter.js";

const prompter = createClackPrompter();
await runInteractiveOnboarding(async () => {
  await prompter.confirm({ message: "Continue?", initialValue: false });
}, defaultRuntime);
