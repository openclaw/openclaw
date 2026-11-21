// Channel setup fallback helpers for the empty-discovery-buckets recovery path.
import type { ChannelChoice } from "../commands/onboard-types.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Shows the standard "enable it before setup" note for disabled-policy guards. */
export async function noteDisabledBeforeSetup(
  prompter: Pick<WizardPrompter, "note">,
  channel: ChannelChoice,
  hint: string,
): Promise<void> {
  await prompter.note(
    t("wizard.channels.disabledBeforeSetup", { channel, hint }),
    t("wizard.channels.setupTitle"),
  );
}
