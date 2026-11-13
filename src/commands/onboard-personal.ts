import {
  enrollDevicesOperator,
  type ConfirmedOperatorEnrollment,
  type EnrollmentOptions,
} from "../cli/devices-cli-enrollment.js";
import { isNamedOperatorRoleEnforcementEnabled } from "../gateway/operator-role-enforcement.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Called only by terminal continuations after inference; browsers own their own offer. */
export async function offerTerminalPersonalSetup(
  prompter: WizardPrompter,
  options: EnrollmentOptions = {},
): Promise<ConfirmedOperatorEnrollment | null> {
  const choice = await prompter.select({
    message: "Set up your personal identity for this terminal?",
    options: [
      {
        value: "setup",
        label: "Set up",
        hint: "Keep your personal settings separate from SharedOwner",
      },
      { value: "skip", label: "Not now", hint: "Continue without changing identity" },
    ],
    initialValue: "skip",
  });
  if (choice !== "setup") {
    return null;
  }
  const enrolled = await enrollDevicesOperator(
    options,
    async (config, selectedProfile) => {
      const namedRoles = isNamedOperatorRoleEnforcementEnabled(config)
        ? config.gateway?.roles
        : undefined;
      const defaultRole = namedRoles?.default;
      const role = selectedProfile
        ? (
            await import("../gateway/operator-role-policy.js")
          ).resolveOperatorRolePolicyForAssignment(
            selectedProfile.id,
            selectedProfile.role ?? null,
            config,
            selectedProfile.githubIdentity?.host
              ? null
              : (selectedProfile.githubIdentity?.login ?? null),
          )
        : defaultRole
          ? namedRoles?.definitions[defaultRole]
          : undefined;
      await prompter.note(
        namedRoles
          ? (selectedProfile
              ? "Selected person's current policy"
              : "Gateway default policy for a new person") +
              ": " +
              (selectedProfile?.effectiveRole ?? defaultRole ?? "no access") +
              ". Scope ceiling: " +
              (role?.scopes.join(", ") || "none") +
              ". No administrator role will be assigned."
          : "This Gateway has no named roles. Personal enrollment keeps the approved device access; it does not assign an administrator role.",
        "Personal access preview",
      );
      if (namedRoles && !role?.scopes.length) {
        throw new Error(
          "The selected Gateway policy grants no operator access. Ask its administrator to choose a person or configure the default role; no person was created.",
        );
      }
    },
    async ({ current, profiles }) => {
      if (!profiles) {
        if (!current) {
          throw new Error("A Gateway administrator must approve personal enrollment.");
        }
        await prompter.note(
          "This terminal already represents " +
            (current.displayName ?? "your current personal profile") +
            ". Keeping its confirmed identity.",
          "Current person",
        );
        return { kind: "keep" };
      }
      const people = profiles.filter((profile) => profile.id !== current?.id);
      const selected = await prompter.select({
        message: "Who should this terminal represent?",
        options: [
          ...(current
            ? [{ value: "current", label: "Keep " + (current.displayName ?? "current person") }]
            : []),
          ...people.map((profile) => ({
            value: "person:" + profile.id,
            label: profile.displayName ?? "Unnamed person · " + profile.id.slice(0, 8),
          })),
          { value: "new", label: "Create a new person", hint: "Optional name; no email required" },
        ],
        initialValue: current ? "current" : people[0] ? "person:" + people[0].id : "new",
      });
      if (selected === "current") {
        return { kind: "keep" };
      }
      if (selected === "new") {
        const name = (
          await prompter.text({ message: "Your name (optional; no email required)" })
        ).trim();
        return { kind: "new", ...(name ? { name } : {}) };
      }
      const person = people.find((profile) => "person:" + profile.id === selected);
      if (!person) {
        throw new Error("Choose one of the available canonical people.");
      }
      return { kind: "existing", profileId: person.id };
    },
  );
  await prompter.note(
    "Personal identity confirmed for profile " +
      enrolled.profileId +
      ". Shared maintenance authentication is unchanged.",
    "Personal setup complete",
  );
  return enrolled;
}

/** Read-only readiness never creates a device or turns model login into Gateway identity. */
export async function prepareTerminalPersonalSetupTarget() {
  const [{ loadConfig }, { resolveGatewayClientBootstrap }, { probeGatewayReachable }] =
    await Promise.all([
      import("../config/config.js"),
      import("../gateway/client-bootstrap.js"),
      import("./onboard-helpers.js"),
    ]);
  const config = loadConfig();
  const target = await resolveGatewayClientBootstrap({ config, authPolicy: "probe" });
  const readiness = await probeGatewayReachable({
    config,
    url: target.url,
    ...target.auth,
    tlsFingerprint: target.tlsFingerprint,
    preauthHandshakeTimeoutMs: target.preauthHandshakeTimeoutMs,
    ...(target.deviceAuthScope ? { originScopedDeviceAuth: true } : {}),
    ...(target.sshTunnel ? { configuredRemote: true } : {}),
  });
  return {
    ready: readiness.ok,
    options: { config, expectUrl: target.url } satisfies EnrollmentOptions,
    canHostLocal: config.gateway?.mode !== "remote" && target.urlOverrideSource === undefined,
  };
}

/** The machine setup receipt alone decides whether the existing child owner may start a Gateway. */
export async function continueTerminalPersonalSetup(
  gateway: import("../wizard/setup.finalize.js").GatewayServiceSetupOutcome,
  runtime: import("../runtime.js").RuntimeEnv,
  continueTerminal: (deviceAuth: boolean) => Promise<void>,
) {
  const target = await prepareTerminalPersonalSetupTarget();
  const finish = async (ready: Awaited<ReturnType<typeof prepareTerminalPersonalSetupTarget>>) => {
    if (!ready.ready || ready.options.expectUrl !== target.options.expectUrl) {
      throw new Error(
        "The selected Gateway is not ready or changed. Personal setup was not offered.",
      );
    }
    const { createClackPrompter } = await import("../wizard/clack-prompter.js");
    const enrolled = await offerTerminalPersonalSetup(createClackPrompter(), ready.options);
    await continueTerminal(enrolled !== null);
  };
  if (target.ready) {
    await finish(target);
    return;
  }
  if (gateway.status === "skipped" && gateway.reason !== "external" && target.canHostLocal) {
    const { runQuickstartForegroundGateway } = await import("./onboard-quickstart-host.js");
    await runQuickstartForegroundGateway({
      runtime,
      expectUrl: target.options.expectUrl,
      onReady: async () => await finish(await prepareTerminalPersonalSetupTarget()),
    });
    return;
  }
  throw new Error(
    "The configured Gateway must be ready before personal setup. Start it through its existing service or external supervisor, then resume onboarding; no person was created.",
  );
}
