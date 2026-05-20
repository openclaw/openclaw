import {
  enableSystemdUserLinger,
  isSystemdUserServiceAvailable,
  readSystemdUserLingerStatus,
} from "../daemon/systemd.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";

export type LingerPrompter = {
  confirm?: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
  note: (message: string, title?: string) => Promise<void> | void;
};

type SystemdUserLingerDeps = {
  isSystemdUserServiceAvailable?: typeof isSystemdUserServiceAvailable;
  readSystemdUserLingerStatus?: typeof readSystemdUserLingerStatus;
  enableSystemdUserLinger?: typeof enableSystemdUserLinger;
};

export type SystemdUserLingerFinding = {
  kind: "unavailable" | "unreadable" | "disabled";
  user?: string;
  message: string;
  fixHint?: string;
};

export const SYSTEMD_GATEWAY_LINGER_REASON =
  "Gateway runs as a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.";

export async function detectSystemdUserLingerFindings(params: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  reason?: string;
  deps?: SystemdUserLingerDeps;
}): Promise<readonly SystemdUserLingerFinding[]> {
  if ((params.platform ?? process.platform) !== "linux") {
    return [];
  }
  const env = params.env ?? process.env;
  const available = await (
    params.deps?.isSystemdUserServiceAvailable ?? isSystemdUserServiceAvailable
  )(env);
  if (!available) {
    return [
      {
        kind: "unavailable",
        message: "Systemd user services are unavailable. Skipping lingering checks.",
      },
    ];
  }
  const status = await (params.deps?.readSystemdUserLingerStatus ?? readSystemdUserLingerStatus)(
    env,
  );
  if (!status) {
    return [
      {
        kind: "unreadable",
        message: "Unable to read loginctl linger status. Ensure systemd + loginctl are available.",
      },
    ];
  }
  if (status.linger === "yes") {
    return [];
  }
  const reason =
    params.reason ??
    "Systemd user services stop when you log out or go idle, which kills the Gateway.";
  return [
    {
      kind: "disabled",
      user: status.user,
      message: reason,
      fixHint: `Run manually: sudo loginctl enable-linger ${status.user}`,
    },
  ];
}

export async function repairSystemdUserLingerFinding(params: {
  runtime: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  confirm?: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
  reason?: string;
  requireConfirm?: boolean;
  deps?: SystemdUserLingerDeps;
}): Promise<{
  status?: "repaired" | "skipped" | "failed";
  changes: string[];
  warnings: string[];
}> {
  const env = params.env ?? process.env;
  const findings = await detectSystemdUserLingerFindings({
    env,
    platform: params.platform,
    reason: params.reason,
    deps: params.deps,
  });
  const disabled = findings.find((finding) => finding.kind === "disabled");
  if (!disabled?.user) {
    return {
      status: findings.length === 0 ? "skipped" : "failed",
      changes: [],
      warnings: findings.map((finding) => finding.message),
    };
  }
  if (params.requireConfirm !== false) {
    if (!params.confirm) {
      return {
        status: "skipped",
        changes: [],
        warnings: ["Without lingering, the Gateway will stop when you log out."],
      };
    }
    const ok = await params.confirm({
      message: `Enable systemd lingering for ${disabled.user}?`,
      initialValue: true,
    });
    if (!ok) {
      return {
        status: "skipped",
        changes: [],
        warnings: ["Without lingering, the Gateway will stop when you log out."],
      };
    }
  }

  const enable = params.deps?.enableSystemdUserLinger ?? enableSystemdUserLinger;
  const resultNoSudo = await enable({ env, user: disabled.user });
  if (resultNoSudo.ok) {
    return {
      status: "repaired",
      changes: [`Enabled systemd lingering for ${disabled.user}.`],
      warnings: [],
    };
  }

  const result = await enable({ env, user: disabled.user, sudoMode: "prompt" });
  if (result.ok) {
    return {
      status: "repaired",
      changes: [`Enabled systemd lingering for ${disabled.user}.`],
      warnings: [],
    };
  }

  const failure = result.stderr || result.stdout || "unknown error";
  params.runtime.error(`Failed to enable lingering: ${failure}`);
  return {
    status: "failed",
    changes: [],
    warnings: [`Run manually: sudo loginctl enable-linger ${disabled.user}`],
  };
}

export async function ensureSystemdUserLingerInteractive(params: {
  runtime: RuntimeEnv;
  prompter?: LingerPrompter;
  env?: NodeJS.ProcessEnv;
  title?: string;
  reason?: string;
  prompt?: boolean;
  requireConfirm?: boolean;
}): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  if (params.prompt === false) {
    return;
  }
  const env = params.env ?? process.env;
  const prompter = params.prompter ?? { note };
  const title = params.title ?? "Systemd";
  const findings = await detectSystemdUserLingerFindings({
    env,
    reason: params.reason,
  });
  if (findings.length === 0) {
    return;
  }
  const [finding] = findings;
  if (!finding) {
    return;
  }
  if (finding.kind !== "disabled") {
    await prompter.note(finding.message, title);
    return;
  }

  const actionNote = params.requireConfirm
    ? "We can enable lingering now (may require sudo; writes /var/lib/systemd/linger)."
    : "Enabling lingering now (may require sudo; writes /var/lib/systemd/linger).";
  await prompter.note(`${finding.message}\n${actionNote}`, title);

  if (params.requireConfirm && prompter.confirm) {
    const ok = await prompter.confirm({
      message: `Enable systemd lingering for ${finding.user}?`,
      initialValue: true,
    });
    if (!ok) {
      await prompter.note("Without lingering, the Gateway will stop when you log out.", title);
      return;
    }
  }

  const resultNoSudo = await enableSystemdUserLinger({
    env,
    user: finding.user,
  });
  if (resultNoSudo.ok) {
    await prompter.note(`Enabled systemd lingering for ${finding.user}.`, title);
    return;
  }

  const result = await enableSystemdUserLinger({
    env,
    user: finding.user,
    sudoMode: "prompt",
  });
  if (result.ok) {
    await prompter.note(`Enabled systemd lingering for ${finding.user}.`, title);
    return;
  }

  params.runtime.error(
    `Failed to enable lingering: ${result.stderr || result.stdout || "unknown error"}`,
  );
  await prompter.note(`Run manually: sudo loginctl enable-linger ${finding.user}`, title);
}

export async function ensureSystemdUserLingerNonInteractive(params: {
  runtime: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  const env = params.env ?? process.env;
  if (!(await isSystemdUserServiceAvailable())) {
    return;
  }
  const status = await readSystemdUserLingerStatus(env);
  if (!status || status.linger === "yes") {
    return;
  }

  const result = await enableSystemdUserLinger({
    env,
    user: status.user,
    sudoMode: "non-interactive",
  });
  if (result.ok) {
    params.runtime.log(`Enabled systemd lingering for ${status.user}.`);
    return;
  }

  params.runtime.log(
    `Systemd lingering is disabled for ${status.user}. Run: sudo loginctl enable-linger ${status.user}`,
  );
}
