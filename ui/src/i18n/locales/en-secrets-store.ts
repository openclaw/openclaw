import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSecretsStore = {
  secretsStore: {
    name: "Name",
    access: "Access",
    accessMode: "Access mode",
    value: "Value",
    allowedHosts: en.secretsStore.allowedHosts,
    allowedHostsPlaceholder: en.secretsStore.allowedHostsPlaceholder,
    allowedHostsHint:
      "Exact hostnames only, one per line or comma-separated. No wildcards or ports.",
    noAllowedHosts: "None",
    updated: "Last updated",
    by: "{time} by {name}",
    actions: "Actions",
    add: "Add",
    edit: "Edit",
    bulk: "Bulk Add",
    protectedSecret: en.secretsStore.protectedSecret,
    protectedSecretHint:
      "Hidden after save and inert unless referenced by a SecretRef or used through enabled destination-bound Gateway egress. It is never directly readable.",
    agentReadable: en.secretsStore.agentReadable,
    agentReadableHint:
      "High risk: visible to admins and plaintext to Gateway-hosted agent commands. The agent can print, transmit, or persist it. Applies from the next run.",
    hint: en.secretsStore.hint,
    required: "Enter a value.",
    detect: "Protect credential-like names automatically",
    detected: "{count} protected secrets detected",
    detectedOne: "{count} protected secret detected",
    unavail: "Gateway/admin required.",
    badName: "Use SERVICE_API_KEY.",
    tooLarge: "Max 64 KiB.",
    savedProtected:
      "Saved {name} as Protected secret. Add a SecretRef or enable destination-bound Gateway egress to use it.",
    savedReadable:
      "Saved {name} as Agent-readable environment. It is available to Gateway-hosted agent commands from the next run.",
    savedMany:
      "Saved {count} entries ({protected} protected, {readable} agent-readable). Protected secrets need a SecretRef or enabled destination-bound Gateway egress; agent-readable environment values reach Gateway-hosted agent commands from the next run.",
    warnings: "{count} runtime warnings.",
    partial: "{saved}/{total}: {error}",
    confirmDelete: "Delete {name}?",
    deleted: "Deleted {name}.",
    deleteFailed: "The secret was not deleted. Reload the list and try again.",
  },
} satisfies TranslationMap;

export const registerSecretsStoreEnglish = Object.assign(
  () => {
    Object.assign(en.secretsStore, enSecretsStore.secretsStore);
  },
  { catalog: enSecretsStore },
);
