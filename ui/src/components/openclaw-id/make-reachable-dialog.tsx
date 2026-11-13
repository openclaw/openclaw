import "../../styles/secret-reveal.css";
import "./make-reachable-dialog.css";
import {
  createMemo,
  createSignal,
  Errored,
  For,
  Loading,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { requestOpenClawIdLinkCode } from "../../lib/openclaw-id/account.ts";
import {
  announceOwnerDeviceKey,
  ensureOwnerDeviceSigner,
} from "../../lib/openclaw-id/device-key.ts";
import { openClawIdFeatureSignal } from "../../lib/openclaw-id/feature-lifetime.ts";
import type { RecoveryKitDetails } from "../../lib/openclaw-id/kit-export.ts";
import {
  LINK_STEPS,
  runLinkSteps,
  type LinkStep,
  type LinkStepState,
} from "../../lib/openclaw-id/link-steps.ts";
import { createOpenClawIdCeremony, linkCodePageUrl } from "../../lib/openclaw-id/link.ts";
import type {
  OpenClawIdLinkPreparation,
  OpenClawIdPublication,
  OpenClawIdSignedIn,
  OpenClawIdStatusResult,
} from "../../lib/openclaw-id/types.ts";
import { openClawIdUiError, type OpenClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showConfirmDialog } from "../confirm-dialog.ts";
import { handleCopyButton } from "../copy-button-state.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { DialogHeader } from "../solid/dialog-header.tsx";
import { Icon } from "../solid/icon.tsx";
import { Tooltip } from "../solid/tooltip.tsx";
import { clawNameFromHostname } from "./claw-name.ts";
import { OpenClawIdErrorMessage } from "./error-message.tsx";
import { RecoveryKitForm } from "./recovery-kit-form.tsx";
import { RecoveryKitPanel } from "./recovery-kit-panel.tsx";
import { createSetupMotion } from "./setup-motion.ts";

function StepTooltip(props: { error: OpenClawIdUiError; failed: boolean }) {
  return (
    <Tooltip class="openclaw-id-steps__tooltip" placement="top-end" openOnClick>
      <button
        type="button"
        class="openclaw-id-steps__info"
        aria-label={props.failed ? t("openclawId.technicalDetails") : props.error.message}
      >
        <Icon name={props.failed ? "circleAlert" : "info"} />
      </button>
      <span slot="content" class="openclaw-id-steps__tip">
        <Show when={!props.failed}>
          <span>{props.error.message}</span>
        </Show>
        <Show when={props.error.detail}>
          <code tabindex={props.error.detail.length > 160 ? 0 : undefined}>
            {props.error.detail}
          </code>
        </Show>
      </span>
    </Tooltip>
  );
}

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);
registerEnglishCatalog(registerOpenClawIdEnglish);

type Step =
  | { kind: "name" }
  | { kind: "kit"; preparation: OpenClawIdLinkPreparation; details: RecoveryKitDetails }
  | { kind: "linking"; hostname: string }
  | { kind: "done"; hostname: string; publication: OpenClawIdPublication | null }
  | { kind: "failed"; hostname: string; message: OpenClawIdUiError };

// The step when it is of `kind`, otherwise false (for <Match when>).
function stepOfKind<K extends Step["kind"]>(
  step: Step,
  kind: K,
): Extract<Step, { kind: K }> | false {
  if (step.kind !== kind) {
    return false;
  }
  // SAFETY: the discriminant was just compared with kind.
  return step as Extract<Step, { kind: K }>;
}

// Whether the claw's outbound relay connection is up (openclawId.status tunnel).
async function readRelayOnline(client: GatewayBrowserClient): Promise<boolean> {
  const result = await client.request<OpenClawIdStatusResult>("openclawId.status", {});
  const tunnel = result.status.tunnel;
  return result.status.state === "on" && tunnel?.state === "running" && tunnel.relayOnline === true;
}

// Publication codes distinguish temporary outages from setup and security refusals.
function publicationError(publication: OpenClawIdPublication | null): OpenClawIdUiError {
  if (publication?.state === "failed") {
    const mapped = openClawIdUiError(publication, "setup");
    if (publication.retryable === true) {
      return { ...mapped, message: `${mapped.message} ${t("openclawId.setupRetrying")}` };
    }
    return ["unavailable", "registration_unavailable"].includes(publication.code)
      ? { ...mapped, message: t("openclawId.publicationStopped") }
      : mapped;
  }
  return {
    message: t(
      publication?.state === "needs_enrollment_code"
        ? "openclawId.doneNeedsLinkCode"
        : "openclawId.publicationPending",
    ),
    detail: "",
  };
}

/** The address Discovery offers for a claw name (openclawId.authority check_name). */
type NameCheck = { name: string; accountTag: string; hostname: string; available: boolean };

/** Emphasize the address without changing the catalog's surrounding copy. */
function AddressMessage(props: { message: string; hostname: string }) {
  const address = () => `https://${props.hostname}`;
  return (
    <For each={props.message.split(address())}>
      {(part, index) => (
        <>
          <Show when={index() > 0}>
            <strong class="openclaw-id-setup__address">{address()}</strong>
          </Show>
          {part}
        </>
      )}
    </For>
  );
}

// The name offered until the owner types one.
const DEFAULT_CLAW_NAME = "claw";

/**
 * "Make reachable" (spec section 4; onboarding mockup steps 5-8): the owner
 * names the claw (Discovery assigns "<name>-<account tag>.<loader domain>" for
 * the link code's account); gets the recovery kit
 * and Continue unlocks only after a save action or the confirmation; then four
 * linking steps run in view: signing with the owner key, pinning it on the
 * claw, registration (possession proof and address reservation) and the relay
 * connection. Only signed statements reach the Gateway. Resolves true once linked.
 * When the Control UI is signed in to OpenClaw ID, the link code comes from the
 * account; otherwise (or if that fails) the owner pastes one.
 */
export function showMakeReachableDialog(params: {
  client: GatewayBrowserClient;
  loaderDomain: string;
  signedIn?: OpenClawIdSignedIn | null;
}): Promise<boolean> {
  const ceremony = createOpenClawIdCeremony();
  // Closes when the feature turns off; the kit's secrets are dropped however it closes.
  const lifetime = { signal: openClawIdFeatureSignal(), value: false };
  return withPromiseModalHost<boolean>(lifetime, (modal) => {
    modal.render(() => {
      let copyLinkLabel!: HTMLSpanElement;
      const motion = createSetupMotion();
      onSettled(motion.observe);
      const [step, setStep] = createSignal<Step>({ kind: "name" });
      const [saved, setSaved] = createSignal(false);
      const [preparing, setPreparing] = createSignal(false);
      const [enrollmentCode, setEnrollmentCode] = createSignal("");
      const [name, setName] = createSignal(DEFAULT_CLAW_NAME);
      const [check, setCheck] = createSignal<NameCheck | null>(null);
      const [nameError, setNameError] = createSignal<OpenClawIdUiError | null>(null);
      const [codeFromAccount, setCodeFromAccount] = createSignal(Boolean(params.signedIn));
      const [codeError, setCodeError] = createSignal<OpenClawIdUiError | null>(null);
      const [closeAttempt, setCloseAttempt] = createSignal<{ result: Promise<boolean> }>();
      const closeResult = createMemo(() => closeAttempt()?.result.then(() => null) ?? null);
      const nameRequest = () => ({
        enrollmentCode: enrollmentCode().trim(),
        name: name().trim().toLowerCase(),
      });
      // Asks the Gateway (and through it Discovery) whether the name is free.
      const checkName = async (code = enrollmentCode()) => {
        setCheck(null);
        setNameError(null);
        if (!code.trim() || !nameRequest().name) {
          return;
        }
        try {
          setCheck(
            await params.client.request<NameCheck>("openclawId.authority", {
              action: "check_name",
              ...nameRequest(),
              enrollmentCode: code.trim(),
            }),
          );
        } catch (error) {
          setNameError(openClawIdUiError(error, "setup"));
        }
      };
      // Fills the link code from the signed-in account, then checks the default name.
      const fillCodeFromAccount = async (signedIn: OpenClawIdSignedIn) => {
        try {
          const code = await requestOpenClawIdLinkCode(params.client, signedIn);
          setEnrollmentCode(code);
          // Solid writes settle later; check the acquired code, not the stale signal.
          await checkName(code);
        } catch (error) {
          setCodeFromAccount(false);
          setCodeError(openClawIdUiError(error, "linkCode"));
        }
      };
      // The account is fixed for this dialog; prefill once it has rendered.
      const signedIn = params.signedIn;
      onSettled(() => {
        if (signedIn) {
          void fillCodeFromAccount(signedIn);
        }
      });
      // Records the address the owner root will sign; Discovery assigns it at registration.
      // One preparation runs at a time, and only the name step accepts its answer, so a
      // late answer never returns the dialog to a step that would make another kit.
      // A plain flag, so a second click in the same tick sees the first one.
      let prepareRunning = false;
      const prepare = async () => {
        if (prepareRunning || modal.settled) {
          return;
        }
        prepareRunning = true;
        setPreparing(true);
        setNameError(null);
        try {
          const preparation = await params.client.request<OpenClawIdLinkPreparation>(
            "openclawId.authority",
            { action: "prepare", ...nameRequest() },
          );
          if (modal.settled) {
            return;
          }
          const kit = await ceremony.createKit();
          if (modal.settled) {
            ceremony.discard();
            return;
          }
          const owner = params.signedIn?.email ?? params.signedIn?.name ?? null;
          setSaved(false);
          setStep({
            kind: "kit",
            preparation,
            details: { kit, hostname: preparation.hostname, owner, createdAt: new Date() },
          });
        } catch (error) {
          setNameError(openClawIdUiError(error, "setup"));
        } finally {
          prepareRunning = false;
          setPreparing(false);
        }
      };
      const finish = (linked: boolean) => {
        ceremony.discard();
        modal.finish(linked);
      };
      const [linkStates, setLinkStates] = createSignal<Record<LinkStep, LinkStepState>>(
        // SAFETY: fromEntries over every LINK_STEPS id builds a complete record.
        Object.fromEntries(LINK_STEPS.map((id) => [id, { state: "waiting" }])) as Record<
          LinkStep,
          LinkStepState
        >,
      );
      // The four honest linking steps (lib/openclaw-id/link-steps.ts).
      const link = async (preparation: OpenClawIdLinkPreparation) => {
        if (modal.settled) {
          return;
        }
        setStep({ kind: "linking", hostname: preparation.hostname });
        let signed: Awaited<ReturnType<typeof ceremony.sign>> | undefined;
        try {
          const publication = await runLinkSteps(
            {
              sign: async () => {
                // Stored before commit, so a lost answer cannot lose the admitted key.
                const device = await ensureOwnerDeviceSigner(preparation.claw_id);
                lifetime.signal?.throwIfAborted();
                signed = await ceremony.sign(preparation, device, t("openclawId.thisBrowser"));
                // The owner key is no longer needed once the statements are signed.
                ceremony.discard();
              },
              commit: async () => {
                lifetime.signal?.throwIfAborted();
                const result = await params.client.request<{
                  publication: OpenClawIdPublication | null;
                }>("openclawId.authority", {
                  action: "commit",
                  ...signed,
                  enrollmentCode: nameRequest().enrollmentCode,
                });
                announceOwnerDeviceKey();
                return result.publication;
              },
              relayOnline: () => readRelayOnline(params.client),
            },
            {
              notPublished: (outcome) => publicationError(outcome).message,
              relayOffline: t("openclawId.stepRelayOffline"),
            },
            (id, state) => setLinkStates((current) => ({ ...current, [id]: state })),
          );
          setStep({ kind: "done", hostname: preparation.hostname, publication });
        } catch (error) {
          ceremony.discard();
          setStep({
            kind: "failed",
            hostname: preparation.hostname,
            message: openClawIdUiError(error, "setup"),
          });
        }
      };
      const progress = () => {
        const current = step();
        return current.kind === "linking" || current.kind === "done" || current.kind === "failed"
          ? current
          : false;
      };
      const stepError = (id: LinkStep): OpenClawIdUiError | null => {
        const current = step();
        const state = linkStates()[id];
        if (
          current.kind === "done" &&
          id === "reserve" &&
          current.publication?.state !== "published"
        ) {
          return publicationError(current.publication);
        }
        if (current.kind === "failed" && state.state === "failed") {
          return current.message;
        }
        return "message" in state ? { message: state.message, detail: "" } : null;
      };
      const needsAttention = () =>
        LINK_STEPS.some((id) => ["warning", "failed"].includes(linkStates()[id].state));
      const requestClose = async () => {
        if (step().kind === "linking" || modal.settled) {
          return;
        }
        // Every user exit confirms before dropping the once-shown kit.
        if (step().kind === "kit") {
          const result = showConfirmDialog({
            title: t("common.cancel"),
            message: t("openclawId.kitBody"),
            confirmLabel: t("common.cancel"),
            cancelLabel: t("common.back"),
            signal: lifetime.signal,
          });
          setCloseAttempt({ result });
          try {
            if (!(await result)) {
              return;
            }
          } catch {
            // The retained outcome slot shows the error without discarding the kit.
            return;
          }
        }
        if (!modal.settled) {
          finish(step().kind === "done");
        }
      };
      const cancel = (event: Event) => {
        event.preventDefault();
        void requestClose();
      };
      return (
        <openclaw-modal-dialog
          class="openclaw-id-setup-dialog"
          label={t("openclawId.dialogTitle")}
          description={t("openclawId.dialogDescription")}
          onModal-cancel={cancel}
        >
          <div
            class="oc-dialog openclaw-id-setup"
            data-noclose={step().kind === "kit" || step().kind === "linking" ? "" : undefined}
          >
            <DialogHeader
              title={t("openclawId.dialogTitle")}
              description={
                step().kind === "name" && codeFromAccount()
                  ? t("openclawId.signedInLinkCode", {
                      account: signedIn?.email ?? t("openclawId.accountFallback"),
                    })
                  : undefined
              }
              onClose={() => void requestClose()}
              closeDisabled={step().kind === "kit" || step().kind === "linking"}
            />
            <div
              class="oc-dialog__body"
              ref={motion.body}
              data-step={
                progress()
                  ? "progress"
                  : step().kind === "name" && !codeFromAccount()
                    ? "manual"
                    : step().kind
              }
            >
              <Switch>
                <Match when={step().kind === "name"}>
                  <Show when={!codeFromAccount()}>
                    <div class="openclaw-id-setup__field">
                      <label for="openclaw-id-link-code">{t("openclawId.enrollmentCode")}</label>
                      <div class="openclaw-id-setup__inline">
                        <input
                          id="openclaw-id-link-code"
                          class="settings-input"
                          type="text"
                          autocomplete="off"
                          spellcheck="false"
                          disabled={preparing()}
                          value={enrollmentCode()}
                          aria-describedby="openclaw-id-code-status"
                          onInput={(event) => {
                            setEnrollmentCode(event.currentTarget.value);
                            setCheck(null);
                          }}
                          onChange={() => void checkName()}
                        />
                        <a
                          class="btn"
                          href={linkCodePageUrl(params.loaderDomain)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("openclawId.getLinkCode")}
                        </a>
                      </div>
                      <div
                        id="openclaw-id-code-status"
                        ref={motion.slot}
                        class={["openclaw-id-setup__status", { "is-error": Boolean(codeError()) }]}
                        role="status"
                      >
                        <Show when={codeError()} fallback={t("openclawId.enrollmentCodeHint")}>
                          {(error) => <OpenClawIdErrorMessage error={error()} />}
                        </Show>
                      </div>
                    </div>
                  </Show>
                  <div class="openclaw-id-setup__field">
                    <label for="openclaw-id-claw-name">{t("openclawId.clawName")}</label>
                    <input
                      id="openclaw-id-claw-name"
                      class="settings-input"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      maxlength={57}
                      disabled={preparing()}
                      value={name()}
                      aria-describedby="openclaw-id-name-status"
                      aria-invalid={nameError() || check()?.available === false ? "true" : "false"}
                      onInput={(event) => {
                        setName(event.currentTarget.value);
                        setCheck(null);
                        setNameError(null);
                      }}
                      onChange={() => void checkName()}
                    />
                    <div
                      id="openclaw-id-name-status"
                      ref={motion.slot}
                      class={[
                        "openclaw-id-setup__status",
                        { "is-error": Boolean(nameError()) || check()?.available === false },
                      ]}
                      role="status"
                    >
                      <Show
                        when={nameError()}
                        fallback={
                          <Show when={check()} fallback={t("openclawId.clawNameHint")}>
                            {(checked) => (
                              <span>
                                <Show
                                  when={checked().available}
                                  fallback={t("openclawId.nameTaken", { host: checked().hostname })}
                                >
                                  <AddressMessage
                                    message={t("openclawId.nameAvailable", {
                                      host: checked().hostname,
                                    })}
                                    hostname={checked().hostname}
                                  />
                                </Show>
                              </span>
                            )}
                          </Show>
                        }
                      >
                        {(error) => <OpenClawIdErrorMessage error={error()} />}
                      </Show>
                    </div>
                  </div>
                  <openclaw-modal-actions>
                    <button type="button" class="btn" onClick={() => void requestClose()}>
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      class="btn primary"
                      disabled={
                        preparing() ||
                        !nameRequest().enrollmentCode ||
                        !nameRequest().name ||
                        check()?.available === false
                      }
                      onClick={() => void prepare()}
                    >
                      <Show when={preparing()}>
                        <Icon name="loaderCircle" class="openclaw-id-setup__spinner" />
                      </Show>
                      {t("openclawId.continue")}
                    </button>
                  </openclaw-modal-actions>
                </Match>
                <Match when={stepOfKind(step(), "kit")}>
                  {(kitStep) => (
                    <>
                      <div class="openclaw-id-kit__lead">
                        <p>
                          <strong>{t("openclawId.kitTitle")}</strong>
                        </p>
                        <p>{t("openclawId.kitBody")}</p>
                      </div>
                      <RecoveryKitForm
                        details={kitStep().details}
                        accountEmail={params.signedIn?.email}
                        saved={saved()}
                        onContinue={() => void link(kitStep().preparation)}
                      >
                        <RecoveryKitPanel
                          details={kitStep().details}
                          accountEmail={params.signedIn?.email}
                          saved={saved()}
                          onSaved={setSaved}
                          statusRef={motion.slot}
                        />
                        <Loading on={closeAttempt()}>
                          <Errored
                            fallback={(error) => (
                              <div class="callout danger" role="alert">
                                <OpenClawIdErrorMessage
                                  error={openClawIdUiError(error(), "setup")}
                                />
                              </div>
                            )}
                          >
                            {closeResult()}
                          </Errored>
                        </Loading>
                        <openclaw-modal-actions>
                          <button type="button" class="btn" onClick={() => void requestClose()}>
                            {t("common.cancel")}
                          </button>
                          <button type="submit" class="btn primary" disabled={!saved()}>
                            {t("openclawId.continue")}
                          </button>
                        </openclaw-modal-actions>
                      </RecoveryKitForm>
                    </>
                  )}
                </Match>
                <Match when={progress()}>
                  {(current) => (
                    <>
                      <div role="status" aria-live="polite">
                        <p
                          class={[
                            "openclaw-id-linking__title",
                            { "is-error": current().kind === "failed" },
                          ]}
                        >
                          <Show
                            when={stepOfKind(current(), "failed")}
                            fallback={
                              <Show
                                when={current().kind === "done"}
                                fallback={t("openclawId.linkingTitle", {
                                  name: clawNameFromHostname(current().hostname),
                                })}
                              >
                                <AddressMessage
                                  message={t("openclawId.doneBody", { host: current().hostname })}
                                  hostname={current().hostname}
                                />
                              </Show>
                            }
                          >
                            {(failed) => failed().message.message}
                          </Show>
                        </p>
                        <ol class="openclaw-id-steps">
                          <For each={LINK_STEPS}>
                            {(id) => {
                              const state = () => linkStates()[id].state;
                              const error = createMemo(() => stepError(id));
                              const tooltip = () => {
                                const value = error();
                                return value && (state() === "warning" || value.detail)
                                  ? value
                                  : null;
                              };
                              return (
                                <li class="openclaw-id-steps__item" data-state={state()}>
                                  <span class="openclaw-id-steps__label">
                                    {t(`openclawId.step_${id}`, {
                                      name: clawNameFromHostname(current().hostname),
                                      host: current().hostname,
                                    })}
                                  </span>
                                  <span class="openclaw-id-steps__mark" ref={motion.mark}>
                                    <Show
                                      when={tooltip()}
                                      fallback={
                                        <Icon
                                          name={
                                            state() === "done"
                                              ? "check"
                                              : state() === "running"
                                                ? "loaderCircle"
                                                : state() === "waiting"
                                                  ? "circleDashed"
                                                  : state() === "failed"
                                                    ? "circleAlert"
                                                    : "info"
                                          }
                                          class={
                                            state() === "running"
                                              ? "openclaw-id-setup__spinner"
                                              : undefined
                                          }
                                        />
                                      }
                                    >
                                      {(value) => (
                                        <StepTooltip
                                          error={value()}
                                          failed={state() === "failed"}
                                        />
                                      )}
                                    </Show>
                                  </span>
                                </li>
                              );
                            }}
                          </For>
                        </ol>
                      </div>
                      <openclaw-modal-actions>
                        <Show when={stepOfKind(step(), "done")}>
                          {(done) => (
                            <Show when={done().publication?.state === "published"}>
                              <button
                                type="button"
                                class="btn"
                                onClick={(event) =>
                                  void handleCopyButton(
                                    event,
                                    `https://${done().hostname}`,
                                    t("openclawId.copyRemoteLink"),
                                    { label: copyLinkLabel },
                                  )
                                }
                              >
                                <Icon name="link" />
                                <span ref={(element) => (copyLinkLabel = element)}>
                                  {t("openclawId.copyRemoteLink")}
                                </span>
                              </button>
                            </Show>
                          )}
                        </Show>
                        <button
                          type="button"
                          class={["btn", { primary: !needsAttention() }]}
                          disabled={current().kind === "linking"}
                          onClick={() => void requestClose()}
                        >
                          {t(needsAttention() ? "common.close" : "openclawId.done")}
                        </button>
                      </openclaw-modal-actions>
                    </>
                  )}
                </Match>
              </Switch>
            </div>
          </div>
        </openclaw-modal-dialog>
      );
    });
  }).finally(() => ceremony.discard());
}
