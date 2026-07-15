export type TerminalDynamicColors = {
  foreground: string;
  background: string;
  cursor: string;
};

type DynamicColorName = keyof TerminalDynamicColors;

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;
const MAX_PENDING_COLOR_SEQUENCE_CHARS = 1024;

const DYNAMIC_COLOR_SLOTS = [
  { color: "foreground", slot: 10 },
  { color: "background", slot: 11 },
  { color: "cursor", slot: 12 },
] as const satisfies Array<{ color: DynamicColorName; slot: number }>;
const DYNAMIC_COLOR_HEADERS = DYNAMIC_COLOR_SLOTS.map(({ slot }) => ({
  sequence: `${ESC}]${slot};`,
  slot,
}));

type OscTerminator = typeof BEL | typeof ST;

function findOscTerminator(
  data: string,
  start: number,
): { index: number; terminator: OscTerminator } | null {
  for (let index = start; index < data.length; index += 1) {
    if (data[index] === BEL) {
      return { index, terminator: BEL };
    }
    if (data[index] === ESC && data[index + 1] === "\\") {
      return { index, terminator: ST };
    }
  }
  return null;
}

function formatOscColor(slot: number, color: string, terminator: OscTerminator): string | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color);
  if (!match) {
    return null;
  }
  const [, red, green, blue] = match;
  return `${ESC}]${slot};rgb:${red}${red}/${green}${green}/${blue}${blue}${terminator}`;
}

/** Answers streamed OSC 10-12 dynamic-color queries like a native terminal. */
export function createTerminalDefaultColorQueryResponder(
  getColors: () => TerminalDynamicColors,
  reply: (data: string) => void,
) {
  let pending = "";

  const process = (data: string, shouldReply: boolean): void => {
    pending += data;
    while (pending.length > 0) {
      const queryStart = pending.indexOf(`${ESC}]`);
      if (queryStart === -1) {
        pending = pending.endsWith(ESC) ? ESC : "";
        return;
      }
      if (queryStart > 0) {
        pending = pending.slice(queryStart);
      }

      const header = DYNAMIC_COLOR_HEADERS.find(({ sequence }) => pending.startsWith(sequence));
      if (!header) {
        if (DYNAMIC_COLOR_HEADERS.some(({ sequence }) => sequence.startsWith(pending))) {
          return;
        }
        pending = pending.slice(1);
        continue;
      }

      const end = findOscTerminator(pending, header.sequence.length);
      if (!end) {
        if (pending.length <= MAX_PENDING_COLOR_SEQUENCE_CHARS) {
          return;
        }
        pending = pending.slice(1);
        continue;
      }

      if (shouldReply) {
        const colors = getColors();
        let slot = header.slot;
        const payload = pending.slice(header.sequence.length, end.index);
        for (const value of payload.split(";")) {
          if (!value) {
            continue;
          }
          const target = DYNAMIC_COLOR_SLOTS.find((entry) => entry.slot === slot);
          if (value === "?" && target) {
            const response = formatOscColor(slot, colors[target.color], end.terminator);
            if (response) {
              reply(response);
            }
          }
          slot += 1;
        }
      }
      pending = pending.slice(end.index + end.terminator.length);
    }
  };

  return {
    observe(data: string): void {
      process(data, true);
    },
    primeFromReplay(data: string): void {
      pending = "";
      process(data, false);
    },
  };
}
