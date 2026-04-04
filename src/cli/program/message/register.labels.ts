import type { Command } from "commander";
import { danger, success } from "../../../globals.js";
import { defaultRuntime } from "../../../runtime.js";
import { runCommandWithRuntime } from "../../cli-utils.js";
import { ensurePluginRegistryLoaded } from "../../plugin-registry.js";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessageLabelCommands(message: Command, _helpers: MessageCliHelpers) {
  const label = message
    .command("label")
    .description("Manage WhatsApp labels")
    .action(() => {
      label.help({ error: true });
    });

  // openclaw message label list [--account <id>]
  label
    .command("list")
    .description("List all WhatsApp labels for an account")
    .option("--account <id>", "WhatsApp account id (default: solayre)")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      ensurePluginRegistryLoaded();
      let failed = false;
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const { getLabelsWhatsApp } =
            await import("../../../../extensions/whatsapp/src/outbound.js");
          const labels = await getLabelsWhatsApp({ accountId: opts.account });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(labels, null, 2));
          } else {
            if (labels.length === 0) {
              defaultRuntime.log("No labels found.");
            } else {
              for (const l of labels) {
                defaultRuntime.log(
                  `  [${l.id}] ${l.name} (color=${l.color ?? "?"}, deleted=${l.deleted ?? false})`,
                );
              }
            }
          }
        },
        (err) => {
          failed = true;
          defaultRuntime.error(danger(String(err)));
        },
      );
      defaultRuntime.exit(failed ? 1 : 0);
    });

  // openclaw message label create --name <name> [--color <n>] [--account <id>]
  label
    .command("create")
    .description("Create a new WhatsApp label")
    .requiredOption("--name <name>", "Label name")
    .option("--color <n>", "Label color index (0-19, default 0)", "0")
    .option("--account <id>", "WhatsApp account id")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      ensurePluginRegistryLoaded();
      let failed = false;
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const { createLabelWhatsApp } =
            await import("../../../../extensions/whatsapp/src/outbound.js");
          const color = parseInt(opts.color, 10) || 0;
          const result = await createLabelWhatsApp(opts.name, color, { accountId: opts.account });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result ?? null, null, 2));
          } else {
            if (result) {
              defaultRuntime.log(
                success(`Created label: [${result.id}] ${result.name} (color=${result.color})`),
              );
            } else {
              defaultRuntime.log("Label created (no ID returned).");
            }
          }
        },
        (err) => {
          failed = true;
          defaultRuntime.error(danger(String(err)));
        },
      );
      defaultRuntime.exit(failed ? 1 : 0);
    });

  // openclaw message label add-to-chat --chat <jid> --label-id <id> [--account <id>]
  label
    .command("add-to-chat")
    .description("Apply a label to a WhatsApp chat")
    .requiredOption("--chat <jid>", "Chat JID or phone number")
    .requiredOption("--label-id <id>", "Label ID to apply")
    .option("--account <id>", "WhatsApp account id")
    .action(async (opts) => {
      ensurePluginRegistryLoaded();
      let failed = false;
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const { addLabelWhatsApp } =
            await import("../../../../extensions/whatsapp/src/outbound.js");
          await addLabelWhatsApp(opts.chat, { id: opts.labelId }, { accountId: opts.account });
          defaultRuntime.log(success(`Label ${opts.labelId} applied to ${opts.chat}`));
        },
        (err) => {
          failed = true;
          defaultRuntime.error(danger(String(err)));
        },
      );
      defaultRuntime.exit(failed ? 1 : 0);
    });
}
