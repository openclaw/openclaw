import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSecretsStore = {
  secretsStore: {
    name: "Name",
    accessMode: "Access mode",
    value: "Value",
    allowedHosts: en.secretsStore.allowedHosts,
    allowedHostsPlaceholder: en.secretsStore.allowedHostsPlaceholder,
    allowedHostsHint:
      "Exact hostnames only, one per line or comma-separated. No wildcards or ports.",
    empty: "No secrets yet.",
    by: "{time} by {name}",
    actions: "Actions",
    add: "Add",
    edit: "Edit",
    addDialogTitle: "Add secret",
    editDialogTitle: "Edit secret",
    bulk: "Bulk add",
    protectedSecret: en.secretsStore.protectedSecret,
    protectedSecretHint:
      "Hidden after save and inert unless referenced by a SecretRef or used through enabled destination-bound Gateway egress. It is never directly readable.",
    agentReadable: en.secretsStore.agentReadable,
    agentReadableHint:
      "High risk: visible to admins and plaintext to Gateway-hosted agent commands. The agent can print, transmit, or persist it. Applies from the next reply.",
    hint: en.secretsStore.hint,
    required: "Enter a value.",
    detect: "Protect entries with sensitive names",
    detected: "{count} protected secrets detected",
    detectedOne: "{count} protected secret detected",
    unavailableOffline: "Reconnect to manage secrets.",
    unavailableAdmin: "Only admins can manage secrets. Ask an admin for access.",
    unavailableGateway: "Update the Gateway to manage secrets here.",
    badName: "Use SERVICE_API_KEY.",
    tooLarge: "Max 64 KiB.",
    savedProtected:
      "Saved {name} as Protected secret. Add a SecretRef or enable destination-bound Gateway egress to use it.",
    savedReadable:
      "Saved {name} as Agent-readable environment. It is available to Gateway-hosted agent commands from the next reply.",
    savedMany:
      "Saved {count} entries ({protected} protected, {readable} agent-readable). Protected secrets need a SecretRef or enabled destination-bound Gateway egress; agent-readable environment values reach Gateway-hosted agent commands from the next reply.",
    warnings: "{count} runtime warnings.",
    partial: "Saved {saved} of {total} entries.",
    partialFailure: "Couldn’t finish the import. Reload the list to check what was saved.\n{error}",
    confirmDelete: "Delete {name}?",
    confirmDeleteMessage: "The stored value can’t be recovered.",
    deleted: "Deleted {name}.",
    deleteFailed: "Couldn’t delete the secret. Reload the list and try again.",
  },
} satisfies TranslationMap;

export const registerSecretsStoreEnglish = Object.assign(
  () => {
    Object.assign(en.secretsStore, enSecretsStore.secretsStore);
  },
  { catalog: enSecretsStore },
);
