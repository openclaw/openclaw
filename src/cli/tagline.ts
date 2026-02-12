const DEFAULT_TAGLINE = "Forge your workflow. Command your data.";

const HOLIDAY_TAGLINES = {
  newYear:
    "New Year's Day: New year, fresh schema — same old EADDRINUSE, but this time we temper it like grown-ups.",
  lunarNewYear:
    "Lunar New Year: May your builds be lucky, your pipelines prosperous, and your merge conflicts hammered flat on the anvil.",
  christmas:
    "Christmas: Ho ho ho — Santa's iron-clad assistant is here to ship joy, roll back chaos, and forge the keys safely.",
  eid: "Eid al-Fitr: Celebration mode: queues cleared, deals closed, and good vibes committed to main with clean history.",
  diwali:
    "Diwali: Let the forge glow bright and the bugs flee — today we light up the terminal and ship with pride.",
  easter:
    "Easter: I found your missing environment variable — consider it a tiny CLI egg hunt with fewer jellybeans.",
  hanukkah:
    "Hanukkah: Eight nights, eight retries, zero shame — may your gateway stay lit and your deployments stay ironclad.",
  halloween:
    "Halloween: Spooky season: beware haunted dependencies, cursed caches, and the ghost of node_modules past.",
  thanksgiving:
    "Thanksgiving: Grateful for stable ports, working DNS, and an agent that reads the logs so nobody has to.",
  valentines:
    "Valentine's Day: Roses are typed, violets are piped — I'll automate the chores so you can spend time with humans.",
} as const;

const TAGLINES: string[] = [
  // Iron / forge metaphors
  "Your terminal just grew iron claws — type something and watch it forge results.",
  "Hot metal, cold data, zero patience for manual entry.",
  "Tempered in TypeScript, quenched in production.",
  "Iron sharpens iron — and this CLI sharpens your workflow.",
  "Gateway online — please keep hands inside the forge at all times.",
  "I'll refactor your busywork like it owes me steel ingots.",
  "Forged in the fires of git rebase, cooled by the tears of resolved conflicts.",
  "The anvil is hot. Your pipeline is hotter.",
  "Strike while the deploy is hot.",
  "Built different. Literally — we use DuckDB.",
  // CRM + data humor
  "I speak fluent SQL, mild sarcasm, and aggressive pipeline-closing energy.",
  "One CLI to rule your contacts, your deals, and your sanity.",
  "If your CRM could bench press, this is what it would look like.",
  "Your CRM grew claws. Your leads never stood a chance.",
  "I don't just autocomplete — I auto-close deals (emotionally), then ask you to review (logically).",
  'Less clicking, more shipping, fewer "where did that contact go" moments.',
  "I can PIVOT your data, but I can't PIVOT your life choices.",
  "Your .env is showing; don't worry, the forge keeps secrets.",
  "If it's repetitive, I'll automate it; if it's hard, I'll bring SQL and a rollback plan.",
  "I don't judge, but your missing API keys are absolutely judging you.",
  // General CLI wit
  "Welcome to the command line: where dreams compile and confidence segfaults.",
  'I run on caffeine, JSON5, and the audacity of "it worked on my machine."',
  "If it works, it's automation; if it breaks, it's a \"learning opportunity.\"",
  "I'll do the boring stuff while you dramatically stare at the logs like it's cinema.",
  "Type the command with confidence — nature will provide the stack trace if needed.",
  "I can grep it, git blame it, and gently roast it — pick your coping mechanism.",
  "Hot reload for config, cold sweat for deploys.",
  "I keep secrets like a vault... unless you print them in debug logs again.",
  "I'm basically a Swiss Army knife, but with more opinions and fewer sharp edges.",
  "If you're lost, run doctor; if you're brave, run prod; if you're wise, run tests.",
  "Your task has been queued; your dignity has been deprecated.",
  "I can't fix your code taste, but I can fix your build and your backlog.",
  "I'm not magic — I'm just extremely persistent with retries and coping strategies.",
  'It\'s not "failing," it\'s "discovering new ways to configure the same thing wrong."',
  "Give me a workspace and I'll give you fewer tabs, fewer toggles, and more oxygen.",
  "I read logs so you can keep pretending you don't have to.",
  "If something's on fire, I can't extinguish it — but I can write a beautiful postmortem.",
  'Say "stop" and I\'ll stop — say "ship" and we\'ll both learn a lesson.',
  "I'm the reason your shell history looks like a hacker-movie montage.",
  "I'm like tmux: confusing at first, then suddenly you can't live without me.",
  "I can run local, remote, or purely on vibes — results may vary with DNS.",
  "If you can describe it, I can probably automate it — or at least make it funnier.",
  "Your config is valid, your assumptions are not.",
  // Multi-channel / product
  "Your inbox, your infra, your rules.",
  'Turning "I\'ll reply later" into "my agent replied instantly".',
  "Chat automation for people who peaked at IRC.",
  "The UNIX philosophy meets your DMs.",
  "Less middlemen, more messages.",
  "Ship fast, log faster.",
  "End-to-end encrypted, drama-to-drama excluded.",
  "The only bot that stays out of your training set.",
  "Chat APIs that don't require a Senate hearing.",
  "Your messages, your servers, your control.",
  "OpenAI-compatible, not OpenAI-dependent.",
  "Because the right answer is usually a script.",
  // Holiday taglines (gated by date rules below)
  HOLIDAY_TAGLINES.newYear,
  HOLIDAY_TAGLINES.lunarNewYear,
  HOLIDAY_TAGLINES.christmas,
  HOLIDAY_TAGLINES.eid,
  HOLIDAY_TAGLINES.diwali,
  HOLIDAY_TAGLINES.easter,
  HOLIDAY_TAGLINES.hanukkah,
  HOLIDAY_TAGLINES.halloween,
  HOLIDAY_TAGLINES.thanksgiving,
  HOLIDAY_TAGLINES.valentines,
];

type HolidayRule = (date: Date) => boolean;

const DAY_MS = 24 * 60 * 60 * 1000;

function utcParts(date: Date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
}

const onMonthDay =
  (month: number, day: number): HolidayRule =>
  (date) => {
    const parts = utcParts(date);
    return parts.month === month && parts.day === day;
  };

const onSpecificDates =
  (dates: Array<[number, number, number]>, durationDays = 1): HolidayRule =>
  (date) => {
    const parts = utcParts(date);
    return dates.some(([year, month, day]) => {
      if (parts.year !== year) {
        return false;
      }
      const start = Date.UTC(year, month, day);
      const current = Date.UTC(parts.year, parts.month, parts.day);
      return current >= start && current < start + durationDays * DAY_MS;
    });
  };

const inYearWindow =
  (
    windows: Array<{
      year: number;
      month: number;
      day: number;
      duration: number;
    }>,
  ): HolidayRule =>
  (date) => {
    const parts = utcParts(date);
    const window = windows.find((entry) => entry.year === parts.year);
    if (!window) {
      return false;
    }
    const start = Date.UTC(window.year, window.month, window.day);
    const current = Date.UTC(parts.year, parts.month, parts.day);
    return current >= start && current < start + window.duration * DAY_MS;
  };

const isFourthThursdayOfNovember: HolidayRule = (date) => {
  const parts = utcParts(date);
  if (parts.month !== 10) {
    return false;
  } // November
  const firstDay = new Date(Date.UTC(parts.year, 10, 1)).getUTCDay();
  const offsetToThursday = (4 - firstDay + 7) % 7; // 4 = Thursday
  const fourthThursday = 1 + offsetToThursday + 21; // 1st + offset + 3 weeks
  return parts.day === fourthThursday;
};

const HOLIDAY_RULES = new Map<string, HolidayRule>([
  [HOLIDAY_TAGLINES.newYear, onMonthDay(0, 1)],
  [
    HOLIDAY_TAGLINES.lunarNewYear,
    onSpecificDates(
      [
        [2025, 0, 29],
        [2026, 1, 17],
        [2027, 1, 6],
      ],
      1,
    ),
  ],
  [
    HOLIDAY_TAGLINES.eid,
    onSpecificDates(
      [
        [2025, 2, 30],
        [2025, 2, 31],
        [2026, 2, 20],
        [2027, 2, 10],
      ],
      1,
    ),
  ],
  [
    HOLIDAY_TAGLINES.diwali,
    onSpecificDates(
      [
        [2025, 9, 20],
        [2026, 10, 8],
        [2027, 9, 28],
      ],
      1,
    ),
  ],
  [
    HOLIDAY_TAGLINES.easter,
    onSpecificDates(
      [
        [2025, 3, 20],
        [2026, 3, 5],
        [2027, 2, 28],
      ],
      1,
    ),
  ],
  [
    HOLIDAY_TAGLINES.hanukkah,
    inYearWindow([
      { year: 2025, month: 11, day: 15, duration: 8 },
      { year: 2026, month: 11, day: 5, duration: 8 },
      { year: 2027, month: 11, day: 25, duration: 8 },
    ]),
  ],
  [HOLIDAY_TAGLINES.halloween, onMonthDay(9, 31)],
  [HOLIDAY_TAGLINES.thanksgiving, isFourthThursdayOfNovember],
  [HOLIDAY_TAGLINES.valentines, onMonthDay(1, 14)],
  [HOLIDAY_TAGLINES.christmas, onMonthDay(11, 25)],
]);

function isTaglineActive(tagline: string, date: Date): boolean {
  const rule = HOLIDAY_RULES.get(tagline);
  if (!rule) {
    return true;
  }
  return rule(date);
}

export interface TaglineOptions {
  env?: NodeJS.ProcessEnv;
  random?: () => number;
  now?: () => Date;
}

export function activeTaglines(options: TaglineOptions = {}): string[] {
  if (TAGLINES.length === 0) {
    return [DEFAULT_TAGLINE];
  }
  const today = options.now ? options.now() : new Date();
  const filtered = TAGLINES.filter((tagline) => isTaglineActive(tagline, today));
  return filtered.length > 0 ? filtered : TAGLINES;
}

export function pickTagline(options: TaglineOptions = {}): string {
  const env = options.env ?? process.env;
  // Check Ironclaw env first, fall back to legacy OpenClaw env
  const override = env?.IRONCLAW_TAGLINE_INDEX ?? env?.OPENCLAW_TAGLINE_INDEX;
  if (override !== undefined) {
    const parsed = Number.parseInt(override, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      const pool = TAGLINES.length > 0 ? TAGLINES : [DEFAULT_TAGLINE];
      return pool[parsed % pool.length];
    }
  }
  const pool = activeTaglines(options);
  const rand = options.random ?? Math.random;
  const index = Math.floor(rand() * pool.length) % pool.length;
  return pool[index];
}

export { TAGLINES, HOLIDAY_RULES, DEFAULT_TAGLINE };
