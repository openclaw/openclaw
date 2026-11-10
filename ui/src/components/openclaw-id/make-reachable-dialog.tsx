import "../../styles/secret-reveal.css";
import "./make-reachable-dialog.css";
import { createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
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
import { clawNameFromHostname } from "./claw-name.ts";
import { OpenClawIdErrorMessage } from "./error-message.tsx";
import { RecoveryKitForm } from "./recovery-kit-form.tsx";
import { RecoveryKitPanel } from "./recovery-kit-panel.tsx";

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
      const [step, setStep] = createSignal<Step>({ kind: "name" });
      const [saved, setSaved] = createSignal(false);
      const [preparing, setPreparing] = createSignal(false);
      const [enrollmentCode, setEnrollmentCode] = createSignal("");
      const [name, setName] = createSignal(DEFAULT_CLAW_NAME);
      const [check, setCheck] = createSignal<NameCheck | null>(null);
      const [nameError, setNameError] = createSignal<OpenClawIdUiError | null>(null);
      const [codeFromAccount, setCodeFromAccount] = createSignal(false);
      const [codeNote, setCodeNote] = createSignal<string | null>(null);
      const [codeError, setCodeError] = createSignal<OpenClawIdUiError | null>(null);
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
        const account = signedIn.email ?? t("openclawId.accountFallback");
        try {
          const code = await requestOpenClawIdLinkCode(params.client, signedIn);
          setEnrollmentCode(code);
          setCodeFromAccount(true);
          setCodeNote(t("openclawId.signedInLinkCode", { account }));
          // Solid writes settle later; check the acquired code, not the stale signal.
          await checkName(code);
        } catch (error) {
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
      const requestClose = async () => {
        if (step().kind === "linking" || modal.settled) {
          return;
        }
        // Every user exit confirms before dropping the once-shown kit.
        if (
          step().kind === "kit" &&
          !(await showConfirmDialog({
            title: t("common.cancel"),
            message: t("openclawId.kitBody"),
            confirmLabel: t("common.cancel"),
            cancelLabel: t("common.back"),
            signal: lifetime.signal,
          }))
        ) {
          return;
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
          label={t("openclawId.dialogTitle")}
          description={t("openclawId.dialogDescription")}
          onModal-cancel={cancel}
        >
          <div class="oc-dialog openclaw-id-setup">
            <DialogHeader
              title={t("openclawId.dialogTitle")}
              description={step().kind === "name" ? codeNote() : undefined}
              closeDisabled={step().kind === "linking"}
              onClose={() => void requestClose()}
            />
            <div class="oc-dialog__body">
              <Switch>
                <Match when={step().kind === "name"}>
                  <Show when={!codeFromAccount()}>
                    <div class="openclaw-id-setup__field">
                      <label for="openclaw-id-link-code">{t("openclawId.enrollmentCode")}</label>
                      <div class="openclaw-id-setup__inline">
                        <input
                          id="openclaw-id-link-code"
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
                        class="openclaw-id-setup__status"
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
                                {checked().available
                                  ? t("openclawId.nameAvailable", { host: checked().hostname })
                                  : t("openclawId.nameTaken", { host: checked().hostname })}
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
                          saved={saved()}
                          onSaved={setSaved}
                        />
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
                        <p class="openclaw-id-linking__title">
                          {current().kind === "done"
                            ? t("openclawId.doneBody", { host: current().hostname })
                            : t("openclawId.linkingTitle", {
                                name: clawNameFromHostname(current().hostname),
                              })}
                        </p>
                        <ol class="openclaw-id-steps">
                          <For each={LINK_STEPS}>
                            {(id) => (
                              <li
                                class="openclaw-id-steps__item"
                                data-state={linkStates()[id].state}
                              >
                                <span class="openclaw-id-steps__mark" aria-hidden="true">
                                  <Icon
                                    name={
                                      linkStates()[id].state === "done"
                                        ? "check"
                                        : linkStates()[id].state === "running"
                                          ? "loaderCircle"
                                          : linkStates()[id].state === "waiting"
                                            ? "circleDashed"
                                            : linkStates()[id].state === "failed"
                                              ? "circleAlert"
                                              : "alertTriangle"
                                    }
                                    class={
                                      linkStates()[id].state === "running"
                                        ? "openclaw-id-setup__spinner"
                                        : undefined
                                    }
                                  />
                                </span>
                                <div>
                                  {t(`openclawId.step_${id}`, {
                                    name: clawNameFromHostname(current().hostname),
                                    host: current().hostname,
                                  })}
                                  <Show when={stepError(id)}>
                                    {(error) => (
                                      <div class="openclaw-id-steps__message">
                                        <OpenClawIdErrorMessage error={error()} />
                                      </div>
                                    )}
                                  </Show>
                                </div>
                              </li>
                            )}
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
                          class={["btn", { primary: current().kind !== "failed" }]}
                          disabled={current().kind === "linking"}
                          onClick={() => void requestClose()}
                        >
                          {t(current().kind === "failed" ? "common.close" : "openclawId.done")}
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
