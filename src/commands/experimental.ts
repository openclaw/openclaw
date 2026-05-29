import { readConfigFileSnapshot } from "../config/config.js";
import { writeExperimentalConfigSelectionToFile } from "../config/experimental-config-file.js";
import { readExperimentalConfigFlagStates } from "../config/experimental-flags.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { danger, info, success } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";

export async function runExperimental(runtime: RuntimeEnv): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    runtime.error(
      danger(
        `Config ${snapshot.exists ? "invalid" : "not found"} at ${shortenHomePath(snapshot.path)}`,
      ),
    );
    if (snapshot.exists) {
      for (const line of formatConfigIssueLines(snapshot.issues, danger("×"), {
        normalizeRoot: true,
      })) {
        runtime.error(`  ${line}`);
      }
    }
    runtime.error(`Run ${theme.accent("openclaw doctor")} to repair, then retry.`);
    runtime.exit(1);
    return;
  }

  const root = snapshot.resolved ?? snapshot.config ?? {};
  const states = readExperimentalConfigFlagStates(root);

  const prompter = createClackPrompter();
  await prompter.intro("OpenClaw experimental flags");

  let selected: string[];
  try {
    selected = await prompter.multiselect<string>({
      message: "Toggle experimental features (space to select, enter to confirm)",
      options: states.map((s) => ({ value: s.path, label: s.label, hint: s.summary })),
      initialValues: states.filter((s) => s.on).map((s) => s.path),
    });
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      await prompter.outro(theme.muted("Cancelled — no changes written."));
      return;
    }
    throw err;
  }

  const picked = new Set(selected);
  const { deltas } = await writeExperimentalConfigSelectionToFile({ selectedPaths: picked });
  if (deltas.length === 0) {
    await prompter.outro(theme.muted("No changes."));
    return;
  }

  const summary = deltas
    .map((d) => `  ${d.next ? success("enabled") : info("disabled")}  ${theme.muted(d.path)}`)
    .join("\n");
  await prompter.note(summary, "Updated config");
  await prompter.outro(`Restart the gateway to apply. (${shortenHomePath(snapshot.path)})`);
}
