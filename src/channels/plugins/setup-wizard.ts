import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { configureChannelAccessWithAllowlist } from "./setup-group-access-configure.js";
import { moveSingleAccountChannelSectionToDefaultAccount } from "./setup-helpers.js";
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
import type { ChannelSetupInput } from "./types.core.js";

export type {
  ChannelSetupWizard,
  ChannelSetupWizardAllowFrom,
  ChannelSetupWizardAllowFromEntry,
  ChannelSetupWizardCredential,
  ChannelSetupWizardCredentialState,
  ChannelSetupWizardEnvShortcut,
  ChannelSetupWizardFinalize,
  ChannelSetupWizardGroupAccess,
  ChannelSetupWizardNote,
  ChannelSetupWizardPrepare,
  ChannelSetupWizardStatus,
  ChannelSetupWizardTextInput,
} from "./setup-wizard-types.js";

type ChannelSetupWizardPlugin = ChannelSetupPlugin;
type ChannelConfigWithDefaultAccount = {
  defaultAccount?: string;
};

async function buildStatus(
  plugin: ChannelSetupWizardPlugin,
  wizard: ChannelSetupWizard,
  ctx: ChannelSetupStatusContext,
): Promise<ChannelSetupStatus> {
  const accountId = ctx.accountOverrides[plugin.id];
  const configured = await wizard.status.resolveConfigured({ cfg: ctx.cfg, accountId });
  const statusLines = (await wizard.status.resolveStatusLines?.({
    cfg: ctx.cfg,
    accountId,
    configured,
  })) ?? [
    `${plugin.meta.label}: ${configured ? wizard.status.configuredLabel : wizard.status.unconfiguredLabel}`,
  ];
  const selectionHint =
    (await wizard.status.resolveSelectionHint?.({
      cfg: ctx.cfg,
      accountId,
      configured,
    })) ?? (configured ? wizard.status.configuredHint : wizard.status.unconfiguredHint);
  const quickstartScore =
    (await wizard.status.resolveQuickstartScore?.({
      cfg: ctx.cfg,
      accountId,
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

function getChannelDefaultAccountSnapshot(
  cfg: OpenClawConfig,
  channelKey: string,
): { hasDefaultAccount: boolean; defaultAccount?: string } {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const channel = channels?.[channelKey] as ChannelConfigWithDefaultAccount | undefined;
  return typeof channel?.defaultAccount === "string"
    ? { hasDefaultAccount: true, defaultAccount: channel.defaultAccount }
    : { hasDefaultAccount: false };
}

function setChannelDefaultAccount(
  cfg: OpenClawConfig,
  channelKey: string,
  accountId: string,
): OpenClawConfig {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const channel = (channels?.[channelKey] as Record<string, unknown> | undefined) ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channelKey]: {
        ...channel,
        defaultAccount: accountId,
      },
    },
  } as OpenClawConfig;
}

function restoreChannelDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  snapshot: { hasDefaultAccount: boolean; defaultAccount?: string };
}): OpenClawConfig {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const channel = (channels?.[params.channelKey] as Record<string, unknown> | undefined) ?? {};
  const nextChannel = params.snapshot.hasDefaultAccount
    ? { ...channel, defaultAccount: params.snapshot.defaultAccount }
    : (({ defaultAccount: _ignored, ...rest }) => rest)(channel);
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: nextChannel,
    },
  } as OpenClawConfig;
}

function createWizardAccountScope(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
}) {
  const accountId = normalizeAccountId(params.accountId);
  // Published WeCom setup callbacks resolve/write the default account even though the
  // host contract passes accountId; scope those callbacks without persisting a default change.
  if (params.channelKey !== "wecom" || accountId === DEFAULT_ACCOUNT_ID) {
    return {
      cfg: params.cfg,
      forCallback: (cfg: OpenClawConfig) => cfg,
      fromCallback: (cfg: OpenClawConfig) => cfg,
    };
  }

  const cfg = moveSingleAccountChannelSectionToDefaultAccount({
    cfg: params.cfg,
    channelKey: params.channelKey,
  });
  const snapshot = getChannelDefaultAccountSnapshot(cfg, params.channelKey);
  return {
    cfg,
    forCallback: (currentCfg: OpenClawConfig) =>
      setChannelDefaultAccount(currentCfg, params.channelKey, accountId),
    fromCallback: (currentCfg: OpenClawConfig) =>
      restoreChannelDefaultAccount({
        cfg: currentCfg,
        channelKey: params.channelKey,
        snapshot,
      }),
  };
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

export function buildChannelSetupWizardAdapterFromSetupWizard(params: {
  plugin: ChannelSetupWizardPlugin;
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

      const accountScope = createWizardAccountScope({
        cfg,
        channelKey: plugin.id,
        accountId,
      });
      let next = accountScope.cfg;
      let credentialValues = collectCredentialValues({
        wizard,
        cfg: accountScope.forCallback(next),
        accountId,
      });
      let usedEnvShortcut = false;

      if (wizard.envShortcut?.isAvailable({ cfg: accountScope.forCallback(next), accountId })) {
        const useEnvShortcut = await prompter.confirm({
          message: wizard.envShortcut.prompt,
          initialValue: true,
        });
        if (useEnvShortcut) {
          next = accountScope.fromCallback(
            await wizard.envShortcut.apply({ cfg: accountScope.forCallback(next), accountId }),
          );
          credentialValues = collectCredentialValues({
            wizard,
            cfg: accountScope.forCallback(next),
            accountId,
          });
          usedEnvShortcut = true;
        }
      }

      const shouldShowIntro =
        !usedEnvShortcut &&
        (wizard.introNote?.shouldShow
          ? await wizard.introNote.shouldShow({
              cfg: accountScope.forCallback(next),
              accountId,
              credentialValues,
            })
          : Boolean(wizard.introNote));
      if (shouldShowIntro && wizard.introNote) {
        await prompter.note(wizard.introNote.lines.join("\n"), wizard.introNote.title);
      }

      if (wizard.prepare) {
        const prepared = await wizard.prepare({
          cfg: accountScope.forCallback(next),
          accountId,
          credentialValues,
          runtime,
          prompter,
          options,
        });
        if (prepared?.cfg) {
          next = accountScope.fromCallback(prepared.cfg);
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
          let credentialState = credential.inspect({
            cfg: accountScope.forCallback(next),
            accountId,
          });
          let resolvedCredentialValue = normalizeOptionalString(credentialState.resolvedValue);
          const shouldPrompt = credential.shouldPrompt
            ? await credential.shouldPrompt({
                cfg: accountScope.forCallback(next),
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
          const allowEnv =
            credential.allowEnv?.({ cfg: accountScope.forCallback(next), accountId }) ?? false;

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
                ? accountScope.fromCallback(
                    await credential.applyUseEnv({
                      cfg: accountScope.forCallback(currentCfg),
                      accountId,
                    }),
                  )
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
                ? accountScope.fromCallback(
                    await credential.applySet({
                      cfg: accountScope.forCallback(currentCfg),
                      accountId,
                      credentialValues,
                      value,
                      resolvedValue,
                    }),
                  )
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
          credentialState = credential.inspect({ cfg: accountScope.forCallback(next), accountId });
          resolvedCredentialValue =
            normalizeOptionalString(credentialResult.resolvedValue) ||
            normalizeOptionalString(credentialState.resolvedValue);
          if (resolvedCredentialValue) {
            credentialValues[credential.inputKey] = resolvedCredentialValue;
          } else {
            delete credentialValues[credential.inputKey];
          }
        }
      };

      const runTextInputSteps = async () => {
        for (const textInput of wizard.textInputs ?? []) {
          let currentValue = normalizeOptionalString(
            typeof credentialValues[textInput.inputKey] === "string"
              ? credentialValues[textInput.inputKey]
              : undefined,
          );
          if (!currentValue && textInput.currentValue) {
            currentValue = normalizeOptionalString(
              await textInput.currentValue({
                cfg: accountScope.forCallback(next),
                accountId,
                credentialValues,
              }),
            );
          }
          const shouldPrompt = textInput.shouldPrompt
            ? await textInput.shouldPrompt({
                cfg: accountScope.forCallback(next),
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
                  cfg: accountScope.forCallback(next),
                  accountId,
                  value: currentValue,
                });
                next = accountScope.fromCallback(next);
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
                  cfg: accountScope.forCallback(next),
                  accountId,
                  value: currentValue,
                });
                next = accountScope.fromCallback(next);
              }
              continue;
            }
          }

          const initialValue = normalizeOptionalString(
            (await textInput.initialValue?.({
              cfg: accountScope.forCallback(next),
              accountId,
              credentialValues,
            })) ?? currentValue,
          );
          const rawValue = await prompter.text({
            message: textInput.message,
            initialValue,
            placeholder: textInput.placeholder,
            validate: (value) => {
              const trimmed = normalizeOptionalString(value) ?? "";
              if (!trimmed && textInput.required !== false) {
                return "Required";
              }
              return textInput.validate?.({
                value: trimmed,
                cfg: accountScope.forCallback(next),
                accountId,
                credentialValues,
              });
            },
          });
          const trimmedValue = rawValue.trim();
          if (!trimmedValue && textInput.required === false) {
            if (textInput.applyEmptyValue) {
              next = await applyWizardTextInputValue({
                plugin,
                input: textInput,
                cfg: accountScope.forCallback(next),
                accountId,
                value: "",
              });
              next = accountScope.fromCallback(next);
            }
            delete credentialValues[textInput.inputKey];
            continue;
          }
          const normalizedValue = normalizeOptionalString(
            textInput.normalizeValue?.({
              value: trimmedValue,
              cfg: accountScope.forCallback(next),
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
            cfg: accountScope.forCallback(next),
            accountId,
            value: normalizedValue,
          });
          next = accountScope.fromCallback(next);
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
          cfg: accountScope.forCallback(next),
          prompter,
          label: access.label,
          currentPolicy: access.currentPolicy({ cfg: accountScope.forCallback(next), accountId }),
          currentEntries: access.currentEntries({ cfg: accountScope.forCallback(next), accountId }),
          placeholder: access.placeholder,
          updatePrompt: access.updatePrompt({ cfg: accountScope.forCallback(next), accountId }),
          skipAllowlistEntries: access.skipAllowlistEntries,
          setPolicy: (currentCfg, policy) =>
            accountScope.fromCallback(
              access.setPolicy({
                cfg: accountScope.forCallback(currentCfg),
                accountId,
                policy,
              }),
            ),
          resolveAllowlist: access.resolveAllowlist
            ? async ({ cfg: currentCfg, entries }) =>
                await access.resolveAllowlist!({
                  cfg: accountScope.forCallback(currentCfg),
                  accountId,
                  credentialValues,
                  entries,
                  prompter,
                })
            : undefined,
          applyAllowlist: access.applyAllowlist
            ? ({ cfg: currentCfg, resolved }) =>
                accountScope.fromCallback(
                  access.applyAllowlist!({
                    cfg: accountScope.forCallback(currentCfg),
                    accountId,
                    resolved,
                  }),
                )
            : undefined,
        });
        next = accountScope.fromCallback(next);
      }

      if (forceAllowFrom && wizard.allowFrom) {
        const allowFrom = wizard.allowFrom;
        const allowFromCredentialValue = normalizeOptionalString(
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
            cfg: accountScope.forCallback(next),
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
              cfg: accountScope.forCallback(next),
              accountId,
              credentialValues,
              entries,
            }),
        });
        next = await allowFrom.apply({
          cfg: accountScope.forCallback(next),
          accountId,
          allowFrom: unique,
        });
        next = accountScope.fromCallback(next);
      }

      if (wizard.finalize) {
        const finalized = await wizard.finalize({
          cfg: accountScope.forCallback(next),
          accountId,
          credentialValues,
          runtime,
          prompter,
          options,
          forceAllowFrom,
        });
        if (finalized?.cfg) {
          next = accountScope.fromCallback(finalized.cfg);
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
              cfg: accountScope.forCallback(next),
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
