import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { writeChannelSection } from "./config-helpers.js";
import { resolveChannelSetupExecutionAdapter } from "./setup-contract.js";
import { configureChannelAccessWithAllowlist } from "./setup-group-access-configure.js";
import {
  moveSingleAccountChannelSectionToDefaultAccount,
  readChannelConfigSection,
} from "./setup-helpers.js";
import {
  promptResolvedAllowFrom,
  resolveAccountIdForConfigure,
  runSingleChannelSecretStep,
  splitSetupEntries,
} from "./setup-wizard-helpers.js";
import type {
  ChannelSetupPlugin,
  ChannelSetupWizardAdapter,
  ChannelSetupWizard,
  ChannelSetupWizardCredentialValues,
  ChannelSetupWizardTextInput,
  ChannelSetupStatus,
  ChannelSetupStatusContext,
} from "./setup-wizard-types.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";
import type { ChannelSetupInput } from "./types.core.js";

export type {
  ChannelSetupWizard,
  ChannelSetupWizardStatus,
  ChannelSetupWizardTextInput,
} from "./setup-wizard-types.js";

function createWizardAccountScope(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  setupSurface?: ChannelSetupAdapter;
}): { cfg: OpenClawConfig; restore: (cfg: OpenClawConfig) => OpenClawConfig } {
  const accountId = normalizeAccountId(params.accountId);
  const initialChannel = readChannelConfigSection(params.cfg, params.channelKey) ?? {};
  // An existing accounts map — even empty — makes legacy plugins write account-scoped
  // while root credentials linger; only a truly absent map may skip promotion.
  if (accountId === DEFAULT_ACCOUNT_ID && initialChannel.accounts === undefined) {
    return { cfg: params.cfg, restore: (cfg) => cfg };
  }

  const cfg = moveSingleAccountChannelSectionToDefaultAccount({
    cfg: params.cfg,
    channelKey: params.channelKey,
    setupSurface: params.setupSurface,
  });
  const channel = readChannelConfigSection(cfg, params.channelKey) ?? {};
  const previousDefaultAccount = channel.defaultAccount;

  // Some shipped plugins ignore accountId and resolve through defaultAccount.
  // Scope their callbacks to this wizard run, then restore the operator's default.
  const scopedCfg = writeChannelSection(cfg, params.channelKey, {
    ...channel,
    // Legacy callbacks use this map to choose account-scoped writes even
    // when there were no root values to promote into a default account.
    accounts: channel.accounts ?? {},
    defaultAccount: accountId,
  });

  return {
    cfg: scopedCfg,
    restore: (currentCfg) => {
      const currentChannel = readChannelConfigSection(currentCfg, params.channelKey) ?? {};
      const restoredChannel =
        previousDefaultAccount !== undefined
          ? { ...currentChannel, defaultAccount: previousDefaultAccount }
          : (({ defaultAccount: _ignored, ...rest }) => rest)(currentChannel);
      return writeChannelSection(currentCfg, params.channelKey, restoredChannel);
    },
  };
}

async function buildStatus(
  plugin: ChannelSetupPlugin,
  wizard: ChannelSetupWizard,
  ctx: ChannelSetupStatusContext,
): Promise<ChannelSetupStatus> {
  const accountId = ctx.accountOverrides[plugin.id];
  const configured = await wizard.status.resolveConfigured({ cfg: ctx.cfg, accountId });
  const statusContext = () => ({ cfg: ctx.cfg, accountId, configured });
  const statusLines = (await wizard.status.resolveStatusLines?.(statusContext())) ?? [
    `${plugin.meta.label}: ${configured ? wizard.status.configuredLabel : wizard.status.unconfiguredLabel}`,
  ];
  const selectionHint =
    (await wizard.status.resolveSelectionHint?.(statusContext())) ??
    (configured ? wizard.status.configuredHint : wizard.status.unconfiguredHint);
  const quickstartScore =
    (await wizard.status.resolveQuickstartScore?.(statusContext())) ??
    (configured ? wizard.status.configuredScore : wizard.status.unconfiguredScore);
  return {
    channel: plugin.id,
    configured,
    statusLines,
    selectionHint,
    quickstartScore,
  };
}

// Channel-owned contracts own config writes; released legacy adapters remain
// supported through the single setup execution compatibility boundary.
function applySetupInput(params: {
  plugin: ChannelSetupPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}) {
  const setup = resolveChannelSetupExecutionAdapter(params.plugin);
  if (!setup?.applyAccountConfig) {
    throw new Error(`${params.plugin.id} does not support setup`);
  }
  let input: unknown = params.input;
  if (params.plugin.setupContract) {
    const parsed = params.plugin.setupContract.parseInput(input);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    input = parsed.value;
  }
  const resolvedAccountId =
    setup.resolveAccountId?.({
      cfg: params.cfg,
      accountId: params.accountId,
      input,
    }) ?? params.accountId;
  const validationError = setup.validateInput?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    input,
  });
  if (validationError) {
    throw new Error(validationError);
  }
  let next = setup.applyAccountConfig({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    input,
  });
  if (params.input.name?.trim() && setup.applyAccountName) {
    next = setup.applyAccountName({
      cfg: next,
      accountId: resolvedAccountId,
      name: params.input.name,
    });
  }
  return next;
}

function collectCredentialValues(params: {
  wizard: ChannelSetupWizard;
  cfg: OpenClawConfig;
  accountId: string;
}): ChannelSetupWizardCredentialValues {
  const values: ChannelSetupWizardCredentialValues = {};
  for (const credential of params.wizard.credentials) {
    const resolvedValue = normalizeOptionalString(
      credential.inspect({
        cfg: params.cfg,
        accountId: params.accountId,
      }).resolvedValue,
    );
    if (resolvedValue) {
      values[credential.inputKey] = resolvedValue;
    }
  }
  return values;
}

function resolveTextInputKeepMessage(
  input: ChannelSetupWizardTextInput,
  currentValue: string,
): string {
  if (input.sensitive === true) {
    // Never pass a configured secret to plugin-owned presentation code.
    return typeof input.keepPrompt === "string"
      ? input.keepPrompt
      : `${input.message} already configured. Keep it?`;
  }
  return typeof input.keepPrompt === "function"
    ? input.keepPrompt(currentValue)
    : (input.keepPrompt ?? `${input.message} set (${currentValue}). Keep it?`);
}

export function buildChannelSetupWizardAdapterFromSetupWizard(params: {
  plugin: ChannelSetupPlugin;
  wizard: ChannelSetupWizard;
}): ChannelSetupWizardAdapter {
  const { plugin, wizard } = params;
  return {
    channel: plugin.id,
    getStatus: async (ctx) => buildStatus(plugin, wizard, ctx),
    configure: async ({
      cfg,
      runtime,
      prompter,
      options,
      accountOverrides,
      shouldPromptAccountIds,
      forceAllowFrom,
    }) => {
      const defaultAccountId =
        plugin.config.defaultAccountId?.(cfg) ??
        plugin.config.listAccountIds(cfg)[0] ??
        DEFAULT_ACCOUNT_ID;
      const resolvedShouldPromptAccountIds =
        wizard.resolveShouldPromptAccountIds?.({
          cfg,
          options,
          shouldPromptAccountIds,
        }) ?? shouldPromptAccountIds;
      const accountSelection = {
        cfg,
        prompter,
        accountOverride: accountOverrides[plugin.id],
        shouldPromptAccountIds: resolvedShouldPromptAccountIds,
        listAccountIds: plugin.config.listAccountIds,
        defaultAccountId,
      };
      const accountId = await (wizard.resolveAccountIdForConfigure
        ? wizard.resolveAccountIdForConfigure({ ...accountSelection, options })
        : resolveAccountIdForConfigure({ ...accountSelection, label: plugin.meta.label }));

      const channel = readChannelConfigSection(cfg, plugin.id) ?? {};
      // Wizards that explicitly own account selection may use defaultAccount as a
      // top-level routing label. Only inject temporary scope when generic selection
      // owns the account or an accounts map proves that scoped storage is in use.
      const shouldScopeAccount =
        wizard.resolveShouldPromptAccountIds === undefined ||
        resolvedShouldPromptAccountIds ||
        channel.accounts !== undefined;
      const accountScope = shouldScopeAccount
        ? createWizardAccountScope({
            cfg,
            channelKey: plugin.id,
            accountId,
            setupSurface: resolveChannelSetupExecutionAdapter(plugin) as
              | ChannelSetupAdapter
              | undefined,
          })
        : { cfg, restore: (currentCfg: OpenClawConfig) => currentCfg };
      let next = accountScope.cfg;
      const accountContext = (currentCfg = next) => ({ cfg: currentCfg, accountId });
      let credentialValues = collectCredentialValues({ wizard, ...accountContext() });
      const stepContext = (currentCfg = next) => ({
        ...accountContext(currentCfg),
        credentialValues,
      });
      const hookContext = () => ({ ...stepContext(), runtime, prompter, options });
      const applyHookResult = (
        result: Awaited<ReturnType<NonNullable<ChannelSetupWizard["prepare"]>>>,
      ) => {
        if (result?.cfg) {
          next = result.cfg;
        }
        if (result?.credentialValues) {
          credentialValues = { ...credentialValues, ...result.credentialValues };
        }
      };
      const setCredentialValue = (key: string, value: string | undefined) => {
        if (value) {
          credentialValues[key] = value;
        } else {
          delete credentialValues[key];
        }
      };
      const applyInput = (input: ChannelSetupInput, currentCfg = next) =>
        applySetupInput({ plugin, ...accountContext(currentCfg), input });
      let usedEnvShortcut = false;
      const showNote = async (note: ChannelSetupWizard["introNote"]) => {
        if (note && (!note.shouldShow || (await note.shouldShow(stepContext())))) {
          await prompter.note(note.lines.join("\n"), note.title);
        }
      };

      // The env shortcut is all-or-nothing. Once accepted, skip credential
      // prompts so the user does not overwrite env-backed setup accidentally.
      if (wizard.envShortcut?.isAvailable(accountContext())) {
        const useEnvShortcut = await prompter.confirm({
          message: wizard.envShortcut.prompt,
          initialValue: true,
        });
        if (useEnvShortcut) {
          next = await wizard.envShortcut.apply(accountContext());
          credentialValues = collectCredentialValues({ wizard, ...accountContext() });
          usedEnvShortcut = true;
        }
      }

      if (!usedEnvShortcut) {
        await showNote(wizard.introNote);
      }

      // Prepare/finalize hooks may derive helper values from credentials.
      // Keep credentialValues current so later optional steps can reuse them.
      if (wizard.prepare) {
        applyHookResult(await wizard.prepare(hookContext()));
      }

      const runCredentialSteps = async () => {
        if (usedEnvShortcut) {
          return;
        }
        for (const credential of wizard.credentials) {
          let credentialState = credential.inspect(accountContext());
          let resolvedCredentialValue = normalizeOptionalString(credentialState.resolvedValue);
          const shouldPrompt = credential.shouldPrompt
            ? await credential.shouldPrompt({
                ...stepContext(),
                currentValue: resolvedCredentialValue,
                state: credentialState,
              })
            : true;
          if (!shouldPrompt) {
            // A skipped credential can still expose a resolved value for later
            // text inputs, allowlist resolution, or finalize hooks.
            setCredentialValue(credential.inputKey, resolvedCredentialValue);
            continue;
          }
          const allowEnv = credential.allowEnv?.(accountContext()) ?? false;

          const credentialResult = await runSingleChannelSecretStep({
            cfg: next,
            prompter,
            providerHint: credential.providerHint,
            credentialLabel: credential.credentialLabel,
            secretInputMode: options?.secretInputMode,
            accountConfigured: credentialState.accountConfigured,
            hasConfigToken: credentialState.hasConfiguredValue,
            allowEnv,
            envValue: credentialState.envValue,
            envPrompt: credential.envPrompt,
            keepPrompt: credential.keepPrompt,
            inputPrompt: credential.inputPrompt,
            preferredEnvVar: credential.preferredEnvVar,
            onMissingConfigured:
              credential.helpLines && credential.helpLines.length > 0
                ? async () => {
                    await prompter.note(
                      credential.helpLines!.join("\n"),
                      credential.helpTitle ?? credential.credentialLabel,
                    );
                  }
                : undefined,
            applyUseEnv: async (currentCfg) =>
              credential.applyUseEnv
                ? await credential.applyUseEnv(accountContext(currentCfg))
                : applyInput({ [credential.inputKey]: undefined, useEnv: true }, currentCfg),
            applySet: async (currentCfg, value, resolvedValue) =>
              credential.applySet
                ? await credential.applySet({
                    ...stepContext(currentCfg),
                    value,
                    resolvedValue,
                  })
                : applyInput({ [credential.inputKey]: value, useEnv: false }, currentCfg),
          });

          next = credentialResult.cfg;
          credentialState = credential.inspect(accountContext());
          resolvedCredentialValue =
            normalizeOptionalString(credentialResult.resolvedValue) ||
            normalizeOptionalString(credentialState.resolvedValue);
          setCredentialValue(credential.inputKey, resolvedCredentialValue);
        }
      };

      const runTextInputSteps = async () => {
        for (const textInput of wizard.textInputs ?? []) {
          const applyValue = async (value: string) => {
            next = textInput.applySet
              ? await textInput.applySet({ ...accountContext(), value })
              : applyInput({ [textInput.inputKey]: value });
          };
          let currentValue = normalizeOptionalString(credentialValues[textInput.inputKey]);
          if (!currentValue && textInput.currentValue) {
            currentValue = normalizeOptionalString(await textInput.currentValue(stepContext()));
          }
          const shouldPrompt = textInput.shouldPrompt
            ? await textInput.shouldPrompt({ ...stepContext(), currentValue })
            : true;

          let keepCurrentValue = !shouldPrompt;
          if (shouldPrompt) {
            if (textInput.helpLines && textInput.helpLines.length > 0) {
              await prompter.note(
                textInput.helpLines.join("\n"),
                textInput.helpTitle ?? textInput.message,
              );
            }
            if (currentValue && textInput.confirmCurrentValue !== false) {
              keepCurrentValue = await prompter.confirm({
                message: resolveTextInputKeepMessage(textInput, currentValue),
                initialValue: true,
              });
            }
          }
          if (keepCurrentValue) {
            if (currentValue) {
              credentialValues[textInput.inputKey] = currentValue;
              if (textInput.applyCurrentValue) {
                // Some inputs are derived from existing config but still need
                // normalization written back before dependent steps run.
                await applyValue(currentValue);
              }
            }
            continue;
          }

          const initialValue =
            textInput.sensitive === true
              ? undefined
              : normalizeOptionalString(
                  (await textInput.initialValue?.(stepContext())) ?? currentValue,
                );
          const rawValue = await prompter.text({
            message: textInput.message,
            placeholder: textInput.placeholder,
            ...(textInput.sensitive === true ? {} : { initialValue }),
            ...(textInput.sensitive === true ? { sensitive: true } : {}),
            validate: (value) => {
              const trimmed = normalizeOptionalString(value) ?? "";
              if (!trimmed && textInput.required !== false) {
                return "Required";
              }
              return textInput.validate?.({ value: trimmed, ...stepContext() });
            },
          });
          const trimmedValue = rawValue.trim();
          if (!trimmedValue && textInput.required === false) {
            if (textInput.applyEmptyValue) {
              await applyValue("");
            }
            delete credentialValues[textInput.inputKey];
            continue;
          }
          const normalizedValue = normalizeOptionalString(
            textInput.normalizeValue?.({ value: trimmedValue, ...stepContext() }) ?? trimmedValue,
          );
          if (!normalizedValue) {
            delete credentialValues[textInput.inputKey];
            continue;
          }
          await applyValue(normalizedValue);
          credentialValues[textInput.inputKey] = normalizedValue;
        }
      };

      if (wizard.stepOrder === "text-first") {
        await runTextInputSteps();
        await runCredentialSteps();
      } else {
        await runCredentialSteps();
        await runTextInputSteps();
      }

      if (wizard.groupAccess) {
        const access = wizard.groupAccess;
        if (access.helpLines && access.helpLines.length > 0) {
          await prompter.note(access.helpLines.join("\n"), access.helpTitle ?? access.label);
        }
        next = await configureChannelAccessWithAllowlist({
          cfg: next,
          prompter,
          label: access.label,
          currentPolicy: access.currentPolicy(accountContext()),
          currentEntries: access.currentEntries(accountContext()),
          placeholder: access.placeholder,
          updatePrompt: access.updatePrompt(accountContext()),
          skipAllowlistEntries: access.skipAllowlistEntries,
          setPolicy: (currentCfg, policy) =>
            access.setPolicy({ ...accountContext(currentCfg), policy }),
          resolveAllowlist: access.resolveAllowlist
            ? async ({ cfg: currentCfg, entries }) =>
                await access.resolveAllowlist!({
                  ...stepContext(currentCfg),
                  entries,
                  prompter,
                })
            : undefined,
          applyAllowlist: access.applyAllowlist
            ? ({ cfg: currentCfg, resolved }) =>
                access.applyAllowlist!({ ...accountContext(currentCfg), resolved })
            : undefined,
        });
      }

      if (forceAllowFrom && wizard.allowFrom) {
        const allowFrom = wizard.allowFrom;
        // Allowlist resolution often needs the freshly entered credential, not
        // only the persisted config, because setup may not have been written yet.
        const credentialInputKey =
          allowFrom.credentialInputKey ??
          wizard.credentials.find((credential) =>
            normalizeOptionalString(credentialValues[credential.inputKey]),
          )?.inputKey ??
          wizard.credentials[0]?.inputKey;
        const allowFromCredentialValue = normalizeOptionalString(
          credentialInputKey === undefined ? undefined : credentialValues[credentialInputKey],
        );
        if (allowFrom.helpLines && allowFrom.helpLines.length > 0) {
          await prompter.note(
            allowFrom.helpLines.join("\n"),
            allowFrom.helpTitle ?? `${plugin.meta.label} allowlist`,
          );
        }
        const existingAllowFrom = plugin.config.resolveAllowFrom?.(accountContext()) ?? [];
        const unique = await promptResolvedAllowFrom({
          prompter,
          existing: existingAllowFrom,
          token: allowFromCredentialValue,
          message: allowFrom.message,
          placeholder: allowFrom.placeholder,
          label: allowFrom.helpTitle ?? `${plugin.meta.label} allowlist`,
          parseInputs: allowFrom.parseInputs ?? splitSetupEntries,
          parseId: allowFrom.parseId,
          invalidWithoutTokenNote: allowFrom.invalidWithoutCredentialNote,
          resolveEntries: async ({ entries }) =>
            allowFrom.resolveEntries({ ...stepContext(), entries }),
        });
        next = await allowFrom.apply({ ...accountContext(), allowFrom: unique });
      }

      if (wizard.finalize) {
        applyHookResult(await wizard.finalize({ ...hookContext(), forceAllowFrom }));
      }

      await showNote(wizard.completionNote);

      return { cfg: accountScope.restore(next), accountId };
    },
    dmPolicy: wizard.dmPolicy,
    disable: wizard.disable,
    onAccountRecorded: wizard.onAccountRecorded,
  };
}
