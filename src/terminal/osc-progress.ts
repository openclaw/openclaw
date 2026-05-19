const OSC_PROGRESS_PREFIX = "\u001b]9;4;";
const OSC_PROGRESS_ST = "\u001b\\";
const OSC_PROGRESS_BEL = "\u0007";
const OSC_PROGRESS_C1_ST = "\u009c";
const OSC_PROGRESS_ESC = String.fromCharCode(0x1b);
const REGEXP_SPECIAL_CHARS = /[\\^$.*+?()[\]{}|]/g;
const OSC_PROGRESS_LABEL_FORBIDDEN_REGEX = new RegExp(
  [OSC_PROGRESS_ST, OSC_PROGRESS_BEL, OSC_PROGRESS_C1_ST, OSC_PROGRESS_ESC, "]"]
    .map((part) => part.replace(REGEXP_SPECIAL_CHARS, "\\$&"))
    .join("|"),
  "g",
);

export type OscProgressController = {
  setIndeterminate: (label: string) => void;
  setPercent: (label: string, percent: number) => void;
  clear: () => void;
};

export function supportsOscProgress(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if (!isTty) {
    return false;
  }
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  return (
    termProgram.includes("ghostty") || termProgram.includes("wezterm") || Boolean(env.WT_SESSION)
  );
}

function sanitizeOscProgressLabel(label: string): string {
  return label.replace(OSC_PROGRESS_LABEL_FORBIDDEN_REGEX, "").trim();
}

function formatOscProgress(state: number, percent: number | null, label: string): string {
  const cleanLabel = sanitizeOscProgressLabel(label);
  if (percent === null) {
    return `${OSC_PROGRESS_PREFIX}${state};;${cleanLabel}${OSC_PROGRESS_ST}`;
  }
  const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
  return `${OSC_PROGRESS_PREFIX}${state};${normalizedPercent};${cleanLabel}${OSC_PROGRESS_ST}`;
}

export function createOscProgressController(params: {
  env: NodeJS.ProcessEnv;
  isTty: boolean;
  write: (chunk: string) => void;
}): OscProgressController {
  if (!supportsOscProgress(params.env, params.isTty)) {
    return {
      setIndeterminate: () => {},
      setPercent: () => {},
      clear: () => {},
    };
  }

  let lastLabel = "";

  return {
    setIndeterminate: (label: string) => {
      lastLabel = label;
      params.write(formatOscProgress(3, null, label));
    },
    setPercent: (label: string, percent: number) => {
      lastLabel = label;
      params.write(formatOscProgress(1, percent, label));
    },
    clear: () => {
      params.write(formatOscProgress(0, 0, lastLabel));
    },
  };
}
