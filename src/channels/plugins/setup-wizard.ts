import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  promptResolvedAllowFrom,
  resolveAccountIdForConfigure,
  runSingleChannelSecretStep,
  splitSetupEntries,
} from "./setup-flow-helpers.js";
import type {
  ChannelSetupFlowAdapter,
  ChannelSetupConfigureContext,
  ChannelSetupDmPolicy,
  ChannelSetupStatus,
  ChannelSetupStatusContext,
} from "./setup-flow-types.js";
import { configureChannelAccessWithAllowlist } from "./setup-group-access-configure.js";
import type { ChannelAccessPolicy } from "./setup-group-access.js";
import type { ChannelSetupInput } from "./types.core.js";
import type { ChannelPlugin } from "./types.js";

export type ChannelSetupWizardStatus = {
  configuredLabel: string;
  unconfiguredLabel: string;
  configuredHint?: string;
  unconfiguredHint?: string;
  configuredScore?: number;
  unconfiguredScore?: number;
  resolveConfigured: (params: { cfg: OpenClawConfig }) => boolean | Promise<boolean>;
  resolveStatusLines?: (params: {
    cfg: OpenClawConfig;
    configured: boolean;
  }) => string[] | Promise<string[]>;
  resolveSelectionHint?: (params: {
    cfg: OpenClawConfig;
    configured: boolean;
  }) => string | undefined | Promise<string | undefined>;
  resolveQuickstartScore?: (params: {
    cfg: OpenClawConfig;
    configured: boolean;
  }) => number | undefined | Promise<number | undefined>;
};

export type ChannelSetupWizardCredentialState = {
  accountConfigured: boolean;
  hasConfiguredValue: boolean;
  resolvedValue?: string;
  envValue?: string;
};

type ChannelSetupWizardCredentialValues = Partial<Record<string, string>>;

export type ChannelSetupWizardNote = {
  title: string;
  lines: string[];
  shouldShow?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => boolean | Promise<boolean>;
};

export type ChannelSetupWizardEnvShortcut = {
  prompt: string;
  preferredEnvVar?: string;
  isAvailable: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  apply: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardCredential = {
  inputKey: keyof ChannelSetupInput;
  providerHint: string;
  credentialLabel: string;
  preferredEnvVar?: string;
  helpTitle?: string;
  helpLines?: string[];
  envPrompt: string;
  keepPrompt: string;
  inputPrompt: string;
  allowEnv?: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  inspect: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => ChannelSetupWizardCredentialState;
  shouldPrompt?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    currentValue?: string;
    state: ChannelSetupWizardCredentialState;
  }) => boolean | Promise<boolean>;
  applyUseEnv?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
  applySet?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    value: unknown;
    resolvedValue: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardTextInput = {
  inputKey: keyof ChannelSetupInput;
  message: string;
  placeholder?: string;
  required?: boolean;
  applyEmptyValue?: boolean;
  helpTitle?: string;
  helpLines?: string[];
  confirmCurrentValue?: boolean;
  keepPrompt?: string | ((value: string) => string);
  currentValue?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string | undefined | Promise<string | undefined>;
  initialValue?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string | undefined | Promise<string | undefined>;
  shouldPrompt?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    currentValue?: string;
  }) => boolean | Promise<boolean>;
  applyCurrentValue?: boolean;
  validate?: (params: {
    value: string;
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string | undefined;
  normalizeValue?: (params: {
    value: string;
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string;
  applySet?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    value: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardAllowFromEntry = {
  input: string;
  resolved: boolean;
  id: string | null;
};

export type ChannelSetupWizardAllowFrom = {
  helpTitle?: string;
  helpLines?: string[];
  credentialInputKey?: keyof ChannelSetupInput;
  message: string;
  placeholder: string;
  invalidWithoutCredentialNote: string;
  parseInputs?: (raw: string) => string[];
  parseId: (raw: string) => string | null;
  resolveEntries: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    entries: string[];
  }) => Promise<ChannelSetupWizardAllowFromEntry[]>;
  apply: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    allowFrom: string[];
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

export type ChannelSetupWizardGroupAccess = {
  label: string;
  placeholder: string;
  helpTitle?: string;
  helpLines?: string[];
  skipAllowlistEntries?: boolean;
  currentPolicy: (params: { cfg: OpenClawConfig; accountId: string }) => ChannelAccessPolicy;
  currentEntries: (params: { cfg: OpenClawConfig; accountId: string }) => string[];
  updatePrompt: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  setPolicy: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    policy: ChannelAccessPolicy;
  }) => OpenClawConfig;
  resolveAllowlist?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    entries: string[];
    prompter: Pick<WizardPrompter, "note">;
  }) => Promise<unknown>;
  applyAllowlist?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    resolved: unknown;
  }) => OpenClawConfig;
};

export type ChannelSetupWizardPrepare = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: ChannelSetupWizardCredentialValues;
  runtime: ChannelSetupConfigureContext["runtime"];
  prompter: WizardPrompter;
  options?: ChannelSetupConfigureContext["options"];
}) =>
  | {
      cfg?: OpenClawConfig;
      credentialValues?: ChannelSetupWizardCredentialValues;
    }
  | void
  | Promise<{
      cfg?: OpenClawConfig;
      credentialValues?: ChannelSetupWizardCredentialValues;
    } | void>;

export type ChannelSetupWizardFinalize = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: ChannelSetupWizardCredentialValues;
  runtime: ChannelSetupConfigureContext["runtime"];
  prompter: WizardPrompter;
  options?: ChannelSetupConfigureContext["options"];
  forceAllowFrom: boolean;
}) =>
  | {
      cfg?: OpenClawConfig;
      credentialValues?: ChannelSetupWizardCredentialValues;
    }
  | void
  | Promise<{
      cfg?: OpenClawConfig;
      credentialValues?: ChannelSetupWizardCredentialValues;
    } | void>;

export type ChannelSetupWizard = {
  channel: string;
  status: ChannelSetupWizardStatus;
  introNote?: ChannelSetupWizardNote;
  envShortcut?: ChannelSetupWizardEnvShortcut;
  resolveAccountIdForConfigure?: (params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    options?: ChannelSetupConfigureContext["options"];
    accountOverride?: string;
    shouldPromptAccountIds: boolean;
    listAccountIds: ChannelSetupWizardPlugin["config"]["listAccountIds"];
    defaultAccountId: string;
  }) => string | Promise<string>;
  resolveShouldPromptAccountIds?: (params: {
    cfg: OpenClawConfig;
    options?: ChannelSetupConfigureContext["options"];
    shouldPromptAccountIds: boolean;
  }) => boolean;
  prepare?: ChannelSetupWizardPrepare;
  stepOrder?: "credentials-first" | "text-first";
  credentials: ChannelSetupWizardCredential[];
  textInputs?: ChannelSetupWizardTextInput[];
  finalize?: ChannelSetupWizardFinalize;
  completionNote?: ChannelSetupWizardNote;
  dmPolicy?: ChannelSetupDmPolicy;
  allowFrom?: ChannelSetupWizardAllowFrom;
  groupAccess?: ChannelSetupWizardGroupAccess;
  disable?: (cfg: OpenClawConfig) => OpenClawConfig;
  onAccountRecorded?: ChannelSetupFlowAdapter["onAccountRecorded"];
};

type ChannelSetupWizardPlugin = Pick<ChannelPlugin, "id" | "meta" | "config" | "setup">;

async function buildStatus(
  plugin: ChannelSetupWizardPlugin,
  wizard: ChannelSetupWizard,
  ctx: ChannelSetupStatusContext,
): Promise<ChannelSetupStatus> {
  const configured = await wizard.status.resolveConfigured({ cfg: ctx.cfg });
  const statusLines = (await wizard.status.resolveStatusLines?.({
    cfg: ctx.cfg,
    configured,
  })) ?? [
    `${plugin.meta.label}: ${configured ? wizard.status.configuredLabel : wizard.status.unconfiguredLabel}`,
  ];
  const selectionHint =
    (await wizard.status.resolveSelectionHint?.({
      cfg: ctx.cfg,
      configured,
    })) ?? (configured ? wizard.status.configuredHint : wizard.status.unconfiguredHint);
  const quickstartScore =
    (await wizard.status.resolveQuickstartScore?.({
      cfg: ctx.cfg,
      configured,
    })) ?? (configured ? wizard.status.configuredScore : wizard.status.unconfiguredScore);
  return {
    channel: plugin.id,
    configured,
    statusLines,
    selectionHint,
    quickstartScore,
  };
}

function applySetupInput(params: {
  plugin: ChannelSetupWizardPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}) {
  const setup = params.plugin.setup;
  if (!setup?.applyAccountConfig) {
    throw new Error(`${params.plugin.id} does not support setup`);
  }
  const resolvedAccountId =
    setup.resolveAccountId?.({
      cfg: params.cfg,
      accountId: params.accountId,
      input: params.input,
    }) ?? params.accountId;
  const validationError = setup.validateInput?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    input: params.input,
  });
  if (validationError) {
    throw new Error(validationError);
  }
  let next = setup.applyAccountConfig({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    input: params.input,
  });
  if (params.input.name?.trim() && setup.applyAccountName) {
    next = setup.applyAccountName({
      cfg: next,
      accountId: resolvedAccountId,
      name: params.input.name,
    });
  }
  return {
    cfg: next,
    accountId: resolvedAccountId,
  };
}

function trimResolvedValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function collectCredentialValues(params: {
  wizard: ChannelSetupWizard;
  cfg: OpenClawConfig;
  accountId: string;
}): ChannelSetupWizardCredentialValues {
  const values: ChannelSetupWizardCredentialValues = {};
  for (const credential of params.wizard.credentials) {
    const resolvedValue = trimResolvedValue(
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

async function applyWizardTextInputValue(params: {
  plugin: ChannelSetupWizardPlugin;
  input: ChannelSetupWizardTextInput;
  cfg: OpenClawConfig;
  accountId: string;
  value: string;
}) {
  return params.input.applySet
    ? await params.input.applySet({
        cfg: params.cfg,
        accountId: params.accountId,
        value: params.value,
      })
    : applySetupInput({
        plugin: params.plugin,
        cfg: params.cfg,
        accountId: params.accountId,
        input: {
          [params.input.inputKey]: params.value,
        },
      }).cfg;
}

export function buildChannelSetupFlowAdapterFromSetupWizard(params: {
  plugin: ChannelSetupWizardPlugin;
  wizard: ChannelSetupWizard;
}): ChannelSetupFlowAdapter {
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
      const accountId = await (wizard.resolveAccountIdForConfigure
        ? wizard.resolveAccountIdForConfigure({
            cfg,
            prompter,
            options,
            accountOverride: accountOverrides[plugin.id],
            shouldPromptAccountIds: resolvedShouldPromptAccountIds,
            listAccountIds: plugin.config.listAccountIds,
            defaultAccountId,
          })
        : resolveAccountIdForConfigure({
            cfg,
            prompter,
            label: plugin.meta.label,
            accountOverride: accountOverrides[plugin.id],
            shouldPromptAccountIds: resolvedShouldPromptAccountIds,
            listAccountIds: plugin.config.listAccountIds,
            defaultAccountId,
          }));

      let next = cfg;
      let credentialValues = collectCredentialValues({
        wizard,
        cfg: next,
        accountId,
      });
      let usedEnvShortcut = false;

      if (wizard.envShortcut?.isAvailable({ cfg: next, accountId })) {
        const useEnvShortcut = await prompter.confirm({
          message: wizard.envShortcut.prompt,
          initialValue: true,
        });
        if (useEnvShortcut) {
          next = await wizard.envShortcut.apply({ cfg: next, accountId });
          credentialValues = collectCredentialValues({
            wizard,
            cfg: next,
            accountId,
          });
          usedEnvShortcut = true;
        }
      }

      const shouldShowIntro =
        !usedEnvShortcut &&
        (wizard.introNote?.shouldShow
          ? await wizard.introNote.shouldShow({
              cfg: next,
              accountId,
              credentialValues,
            })
          : Boolean(wizard.introNote));
      if (shouldShowIntro && wizard.introNote) {
        await prompter.note(wizard.introNote.lines.join("\n"), wizard.introNote.title);
      }

      if (wizard.prepare) {
        const prepared = await wizard.prepare({
          cfg: next,
          accountId,
          credentialValues,
          runtime,
          prompter,
          options,
        });
        if (prepared?.cfg) {
          next = prepared.cfg;
        }
        if (prepared?.credentialValues) {
          credentialValues = {
            ...credentialValues,
            ...prepared.credentialValues,
          };
        }
      }

      const runCredentialSteps = async () => {
        if (usedEnvShortcut) {
          return;
        }
        for (const credential of wizard.credentials) {
          let credentialState = credential.inspect({ cfg: next, accountId });
          let resolvedCredentialValue = trimResolvedValue(credentialState.resolvedValue);
          const shouldPrompt = credential.shouldPrompt
            ? await credential.shouldPrompt({
                cfg: next,
                accountId,
                credentialValues,
                currentValue: resolvedCredentialValue,
                state: credentialState,
              })
            : true;
          if (!shouldPrompt) {
            if (resolvedCredentialValue) {
              credentialValues[credential.inputKey] = resolvedCredentialValue;
            } else {
              delete credentialValues[credential.inputKey];
            }
            continue;
          }
          const allowEnv = credential.allowEnv?.({ cfg: next, accountId }) ?? false;

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
                ? await credential.applyUseEnv({
                    cfg: currentCfg,
                    accountId,
                  })
                : applySetupInput({
                    plugin,
                    cfg: currentCfg,
                    accountId,
                    input: {
                      [credential.inputKey]: undefined,
                      useEnv: true,
                    },
                  }).cfg,
            applySet: async (currentCfg, value, resolvedValue) => {
              resolvedCredentialValue = resolvedValue;
              return credential.applySet
                ? await credential.applySet({
                    cfg: currentCfg,
                    accountId,
                    credentialValues,
                    value,
                    resolvedValue,
                  })
                : applySetupInput({
                    plugin,
                    cfg: currentCfg,
                    accountId,
                    input: {
                      [credential.inputKey]: value,
                      useEnv: false,
                    },
                  }).cfg;
            },
          });

          next = credentialResult.cfg;
          credentialState = credential.inspect({ cfg: next, accountId });
          resolvedCredentialValue =
            trimResolvedValue(credentialResult.resolvedValue) ||
            trimResolvedValue(credentialState.resolvedValue);
          if (resolvedCredentialValue) {
            credentialValues[credential.inputKey] = resolvedCredentialValue;
          } else {
            delete credentialValues[credential.inputKey];
          }
        }
      };

      const runTextInputSteps = async () => {
        for (const textInput of wizard.textInputs ?? []) {
          let currentValue = trimResolvedValue(
            typeof credentialValues[textInput.inputKey] === "string"
              ? credentialValues[textInput.inputKey]
              : undefined,
          );
          if (!currentValue && textInput.currentValue) {
            currentValue = trimResolvedValue(
              await textInput.currentValue({
                cfg: next,
                accountId,
                credentialValues,
              }),
            );
          }
          const shouldPrompt = textInput.shouldPrompt
            ? await textInput.shouldPrompt({
                cfg: next,
                accountId,
                credentialValues,
                currentValue,
              })
            : true;

          if (!shouldPrompt) {
            if (currentValue) {
              credentialValues[textInput.inputKey] = currentValue;
              if (textInput.applyCurrentValue) {
                next = await applyWizardTextInputValue({
                  plugin,
                  input: textInput,
                  cfg: next,
                  accountId,
                  value: currentValue,
                });
              }
            }
            continue;
          }

          if (textInput.helpLines && textInput.helpLines.length > 0) {
            await prompter.note(
              textInput.helpLines.join("\n"),
              textInput.helpTitle ?? textInput.message,
            );
          }

          if (currentValue && textInput.confirmCurrentValue !== false) {
            const keep = await prompter.confirm({
              message:
                typeof textInput.keepPrompt === "function"
                  ? textInput.keepPrompt(currentValue)
                  : (textInput.keepPrompt ??
                    `${textInput.message} set (${currentValue}). Keep it?`),
              initialValue: true,
            });
            if (keep) {
              credentialValues[textInput.inputKey] = currentValue;
              if (textInput.applyCurrentValue) {
                next = await applyWizardTextInputValue({
                  plugin,
                  input: textInput,
                  cfg: next,
                  accountId,
                  value: currentValue,
                });
              }
              continue;
            }
          }

          const initialValue = trimResolvedValue(
            (await textInput.initialValue?.({
              cfg: next,
              accountId,
              credentialValues,
            })) ?? currentValue,
          );
          const rawValue = String(
            await prompter.text({
              message: textInput.message,
              initialValue,
              placeholder: textInput.placeholder,
              validate: (value) => {
                const trimmed = String(value ?? "").trim();
                if (!trimmed && textInput.required !== false) {
                  return "Required";
                }
                return textInput.validate?.({
                  value: trimmed,
                  cfg: next,
                  accountId,
                  credentialValues,
                });
              },
            }),
          );
          const trimmedValue = rawValue.trim();
          if (!trimmedValue && textInput.required === false) {
            if (textInput.applyEmptyValue) {
              next = await applyWizardTextInputValue({
                plugin,
                input: textInput,
                cfg: next,
                accountId,
                value: "",
              });
            }
            delete credentialValues[textInput.inputKey];
            continue;
          }
          const normalizedValue = trimResolvedValue(
            textInput.normalizeValue?.({
              value: trimmedValue,
              cfg: next,
              accountId,
              credentialValues,
            }) ?? trimmedValue,
          );
          if (!normalizedValue) {
            delete credentialValues[textInput.inputKey];
            continue;
          }
          next = await applyWizardTextInputValue({
            plugin,
            input: textInput,
            cfg: next,
            accountId,
            value: normalizedValue,
          });
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
          currentPolicy: access.currentPolicy({ cfg: next, accountId }),
          currentEntries: access.currentEntries({ cfg: next, accountId }),
          placeholder: access.placeholder,
          updatePrompt: access.updatePrompt({ cfg: next, accountId }),
          skipAllowlistEntries: access.skipAllowlistEntries,
          setPolicy: (currentCfg, policy) =>
            access.setPolicy({
              cfg: currentCfg,
              accountId,
              policy,
            }),
          resolveAllowlist: access.resolveAllowlist
            ? async ({ cfg: currentCfg, entries }) =>
                await access.resolveAllowlist!({
                  cfg: currentCfg,
                  accountId,
                  credentialValues,
                  entries,
                  prompter,
                })
            : undefined,
          applyAllowlist: access.applyAllowlist
            ? ({ cfg: currentCfg, resolved }) =>
                access.applyAllowlist!({
                  cfg: currentCfg,
                  accountId,
                  resolved,
                })
            : undefined,
        });
      }

      if (forceAllowFrom && wizard.allowFrom) {
        const allowFrom = wizard.allowFrom;
        const allowFromCredentialValue = trimResolvedValue(
          credentialValues[allowFrom.credentialInputKey ?? wizard.credentials[0]?.inputKey],
        );
        if (allowFrom.helpLines && allowFrom.helpLines.length > 0) {
          await prompter.note(
            allowFrom.helpLines.join("\n"),
            allowFrom.helpTitle ?? `${plugin.meta.label} allowlist`,
          );
        }
        const existingAllowFrom =
          plugin.config.resolveAllowFrom?.({
            cfg: next,
            accountId,
          }) ?? [];
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
            allowFrom.resolveEntries({
              cfg: next,
              accountId,
              credentialValues,
              entries,
            }),
        });
        next = await allowFrom.apply({
          cfg: next,
          accountId,
          allowFrom: unique,
        });
      }

      if (wizard.finalize) {
        const finalized = await wizard.finalize({
          cfg: next,
          accountId,
          credentialValues,
          runtime,
          prompter,
          options,
          forceAllowFrom,
        });
        if (finalized?.cfg) {
          next = finalized.cfg;
        }
        if (finalized?.credentialValues) {
          credentialValues = {
            ...credentialValues,
            ...finalized.credentialValues,
          };
        }
      }

      const shouldShowCompletionNote =
        wizard.completionNote &&
        (wizard.completionNote.shouldShow
          ? await wizard.completionNote.shouldShow({
              cfg: next,
              accountId,
              credentialValues,
            })
          : true);
      if (shouldShowCompletionNote && wizard.completionNote) {
        await prompter.note(wizard.completionNote.lines.join("\n"), wizard.completionNote.title);
      }

      return { cfg: next, accountId };
    },
    dmPolicy: wizard.dmPolicy,
    disable: wizard.disable,
    onAccountRecorded: wizard.onAccountRecorded,
  };
}
