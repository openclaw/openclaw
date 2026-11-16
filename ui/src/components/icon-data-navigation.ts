import { strokeIconData, type IconData } from "./icon-data-types.ts";

// Navigation section icons: outline at rest, `*Filled` for the current page.
// Drawn on a 24 grid, stroke 2, round caps and joins. `users` reuses the
// existing Lucide outline. Mask ids are scoped per rendered instance by Icon.
export const navigationIconData = {
  usersFilled: strokeIconData([
    [
      "path",
      {
        d: "M17 18.991V21c-.01.28-.112.541-.32.733A1.03 1.03 0 0 1 16 22H2a1.02 1.02 0 0 1-.733-.32A1.03 1.03 0 0 1 1 21l.001-2.107c.016-.543.11-1.078.294-1.59a5.04 5.04 0 0 1 1.73-2.322 5 5 0 0 1 2.026-.891c.311-.06.624-.084.94-.09h6.018c.387.008.767.045 1.145.134a5.01 5.01 0 0 1 3.67 3.547c.117.429.167.866.176 1.31m6 0V21c-.01.28-.112.541-.32.733A1.03 1.03 0 0 1 22 22h-3.483c-.184-.012-.34-.139-.35-.332-.005-.096.034-.192.05-.286.021-.127.029-.253.033-.382l-.002-2.142a6.3 6.3 0 0 0-.983-3.226 6.4 6.4 0 0 0-.7-.901c-.097-.104-.208-.186-.229-.333-.02-.15.061-.3.197-.364a.4.4 0 0 1 .15-.034h1.326c.387.008.767.045 1.145.134a5.01 5.01 0 0 1 3.67 3.547c.117.429.167.866.176 1.31M15.207 2.004c.32.019.634.056.947.13a5 5 0 0 1 3.421 2.846c.335.757.475 1.596.409 2.421a5.04 5.04 0 0 1-2.009 3.618 5.03 5.03 0 0 1-4.135.845c-.06-.014-.127-.027-.182-.058a.354.354 0 0 1-.145-.459c.051-.104.172-.209.233-.281q.08-.093.157-.191.387-.49.67-1.045a6.3 6.3 0 0 0 .673-2.626 6.28 6.28 0 0 0-1.559-4.339c-.067-.076-.15-.143-.187-.24a.354.354 0 0 1 .146-.425c.116-.069.28-.086.408-.11a5.5 5.5 0 0 1 1.153-.086m-5.889.006a4.99 4.99 0 0 1 2.424.809A5.04 5.04 0 0 1 14 7.02a5.04 5.04 0 0 1-1.659 3.7 5.04 5.04 0 0 1-3.659 1.27 5.04 5.04 0 0 1-3.595-1.877 5.04 5.04 0 0 1-1.049-3.729A5.04 5.04 0 0 1 6.81 2.505a5 5 0 0 1 1.713-.482c.266-.026.529-.023.795-.013",
        fill: "currentColor",
        "fill-rule": "evenodd",
        stroke: "none",
      },
    ],
  ]),
  dashboards: strokeIconData([
    ["rect", { width: "7", height: "9", x: "3", y: "3", rx: "1" }],
    ["rect", { width: "7", height: "5", x: "14", y: "3", rx: "1" }],
    ["rect", { width: "7", height: "9", x: "14", y: "12", rx: "1" }],
    ["rect", { width: "7", height: "5", x: "3", y: "16", rx: "1" }],
  ]),
  dashboardsFilled: strokeIconData([
    ["rect", { width: "7", height: "9", x: "3", y: "3", rx: "1", fill: "currentColor" }],
    ["rect", { width: "7", height: "5", x: "14", y: "3", rx: "1", fill: "currentColor" }],
    ["rect", { width: "7", height: "9", x: "14", y: "12", rx: "1", fill: "currentColor" }],
    ["rect", { width: "7", height: "5", x: "3", y: "16", rx: "1", fill: "currentColor" }],
  ]),
  usage: strokeIconData([
    ["path", { d: "m12 14 4-4" }],
    ["path", { d: "M3.34 19a10 10 0 1 1 17.32 0" }],
  ]),
  usageFilled: strokeIconData([
    [
      "mask",
      { id: "cu-gauge" },
      [
        ["rect", { width: "24", height: "24", fill: "#fff", stroke: "none" }],
        [
          "path",
          {
            d: "m12 14 4.2-4.2",
            stroke: "#000",
            "stroke-width": "2.2",
            "stroke-linecap": "round",
            fill: "none",
          },
        ],
      ],
    ],
    ["path", { mask: "url(#cu-gauge)", fill: "currentColor", d: "M3.34 19a10 10 0 1 1 17.32 0z" }],
  ]),
  automations: strokeIconData([
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M12 6v6l4 2" }],
  ]),
  automationsFilled: strokeIconData([
    [
      "mask",
      { id: "cu-clock" },
      [
        ["rect", { width: "24", height: "24", fill: "#fff", stroke: "none" }],
        [
          "path",
          {
            d: "M12 6.5V12l3.6 1.8",
            stroke: "#000",
            "stroke-width": "2",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            fill: "none",
          },
        ],
      ],
    ],
    ["circle", { mask: "url(#cu-clock)", fill: "currentColor", cx: "12", cy: "12", r: "10" }],
  ]),
  sessions: strokeIconData([
    [
      "path",
      {
        d: "M19.95 10.05a7 7 0 011.412 7.872 1 1 0 00-.058.787l.675 2.089a1 1 0 01-1.236 1.168l-2.155-.631a1 1 0 00-.745.06 7 7 0 01-7.793-1.445",
      },
    ],
    [
      "path",
      {
        d: "M2.696 12.708a1 1 0 00-.058-.785 7 7 0 113.518 3.473 1 1 0 00-.744-.061l-2.155.63a1 1 0 01-1.236-1.167z",
      },
    ],
  ]),
  sessionsFilled: strokeIconData([
    [
      "path",
      {
        d: "M18.42 7.768 A8 8 0 0 1 22.18 18.53 Q22.06 18.77 22.15 19.02 L22.92 21.40 Q23.25 22.51 22.19 22.87 Q21.84 23.04 21.35 22.88 L18.88 22.16 Q18.62 22.08 18.38 22.19 A8 8 0 0 1 7.768 18.42 A9.5 9.5 0 0 0 18.42 7.768Z",
        fill: "currentColor",
        stroke: "none",
      },
    ],
    [
      "path",
      {
        d: "M2.696 12.708a1 1 0 00-.058-.785 7 7 0 113.518 3.473 1 1 0 00-.744-.061l-2.155.63a1 1 0 01-1.236-1.167z",
        fill: "currentColor",
      },
    ],
  ]),
  systems: strokeIconData([
    ["rect", { width: "20", height: "8", x: "2", y: "2", rx: "2", ry: "2" }],
    ["rect", { width: "20", height: "8", x: "2", y: "14", rx: "2", ry: "2" }],
    ["line", { x1: "6", x2: "6.01", y1: "6", y2: "6" }],
    ["line", { x1: "6", x2: "6.01", y1: "18", y2: "18" }],
  ]),
  systemsFilled: strokeIconData([
    [
      "mask",
      { id: "cu-srv" },
      [
        ["rect", { width: "24", height: "24", fill: "#fff", stroke: "none" }],
        ["circle", { cx: "6", cy: "6", r: "1.3", fill: "#000", stroke: "none" }],
        ["circle", { cx: "6", cy: "18", r: "1.3", fill: "#000", stroke: "none" }],
      ],
    ],
    [
      "g",
      { mask: "url(#cu-srv)", fill: "currentColor" },
      [
        ["rect", { width: "20", height: "8", x: "2", y: "2", rx: "2" }],
        ["rect", { width: "20", height: "8", x: "2", y: "14", rx: "2" }],
      ],
    ],
  ]),
  meetings: strokeIconData([
    ["path", { d: "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" }],
    ["rect", { x: "2", y: "6", width: "14", height: "12", rx: "2" }],
  ]),
  meetingsFilled: strokeIconData([
    [
      "path",
      {
        fill: "currentColor",
        d: "m17.6 13.2 3.623 2.282a.5.5 0 0 0 .777-.416V8.87a.5.5 0 0 0-.752-.432L17.6 10.7z",
      },
    ],
    ["rect", { fill: "currentColor", x: "2", y: "6", width: "13", height: "12", rx: "2" }],
  ]),
  customize: strokeIconData([
    ["rect", { width: "7", height: "7", x: "3", y: "3", rx: "1.5" }],
    ["rect", { width: "7", height: "7", x: "14", y: "3", rx: "1.5" }],
    ["rect", { width: "7", height: "7", x: "3", y: "14", rx: "1.5" }],
    ["path", { d: "M17.5 14.5v6M14.5 17.5h6" }],
  ]),
  customizeFilled: strokeIconData([
    ["rect", { width: "7", height: "7", x: "3", y: "3", rx: "1.5", fill: "currentColor" }],
    ["rect", { width: "7", height: "7", x: "14", y: "3", rx: "1.5", fill: "currentColor" }],
    ["rect", { width: "7", height: "7", x: "3", y: "14", rx: "1.5", fill: "currentColor" }],
    ["path", { d: "M17.5 14.5v6M14.5 17.5h6" }],
  ]),
  portals: strokeIconData([
    ["path", { d: "M4 21v-9a8 8 0 0 1 16 0v9" }],
    ["path", { d: "M9 21v-8.5a3 3 0 0 1 6 0V21" }],
  ]),
  portalsFilled: strokeIconData([
    [
      "mask",
      { id: "cu-portal" },
      [
        ["rect", { width: "24", height: "24", fill: "#fff", stroke: "none" }],
        [
          "path",
          {
            d: "M9 23v-10.5a3 3 0 0 1 6 0V23",
            stroke: "#000",
            "stroke-width": "1.8",
            fill: "none",
          },
        ],
      ],
    ],
    ["path", { mask: "url(#cu-portal)", fill: "currentColor", d: "M4 21v-9a8 8 0 0 1 16 0v9z" }],
  ]),
  workboard: strokeIconData([
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M8 7v7" }],
    ["path", { d: "M12 7v4" }],
    ["path", { d: "M16 7v9" }],
  ]),
  workboardFilled: strokeIconData([
    [
      "mask",
      { id: "cu-kb" },
      [
        ["rect", { width: "24", height: "24", fill: "#fff", stroke: "none" }],
        [
          "path",
          {
            d: "M8 7v7M12 7v4M16 7v9",
            stroke: "#000",
            "stroke-width": "2",
            "stroke-linecap": "round",
            fill: "none",
          },
        ],
      ],
    ],
    [
      "rect",
      {
        mask: "url(#cu-kb)",
        fill: "currentColor",
        width: "18",
        height: "18",
        x: "3",
        y: "3",
        rx: "2",
      },
    ],
  ]),
  clawrouter: strokeIconData([
    ["circle", { cx: "5", cy: "12", r: "2" }],
    ["circle", { cx: "19", cy: "6", r: "2" }],
    ["circle", { cx: "19", cy: "18", r: "2" }],
    ["path", { d: "M7 12h2c3.5 0 3.5-6 8-6" }],
    ["path", { d: "M7 12h2c3.5 0 3.5 6 8 6" }],
  ]),
  clawrouterFilled: strokeIconData([
    ["circle", { cx: "5", cy: "12", r: "2", fill: "currentColor" }],
    ["circle", { cx: "19", cy: "6", r: "2", fill: "currentColor" }],
    ["circle", { cx: "19", cy: "18", r: "2", fill: "currentColor" }],
    ["path", { d: "M7 12h2c3.5 0 3.5-6 8-6" }],
    ["path", { d: "M7 12h2c3.5 0 3.5 6 8 6" }],
  ]),
  knowledge: strokeIconData([
    [
      "path",
      {
        d: "M12 .75c.55 2.6 1.65 3.7 4.25 4.25-2.6.55-3.7 1.65-4.25 4.25-.55-2.6-1.65-3.7-4.25-4.25 2.6-.55 3.7-1.65 4.25-4.25z",
        fill: "currentColor",
        stroke: "none",
      },
    ],
    [
      "path",
      {
        d: "M2 10.5c3.2-1 6.7-.6 10 1.5 3.3-2.1 6.8-2.5 10-1.5v9c-3.2-1-6.7-.6-10 1.5-3.3-2.1-6.8-2.5-10-1.5z",
      },
    ],
    ["path", { d: "M12 12v9" }],
  ]),
  knowledgeFilled: strokeIconData([
    [
      "path",
      {
        d: "M12 .75c.55 2.6 1.65 3.7 4.25 4.25-2.6.55-3.7 1.65-4.25 4.25-.55-2.6-1.65-3.7-4.25-4.25 2.6-.55 3.7-1.65 4.25-4.25z",
        fill: "currentColor",
        stroke: "none",
      },
    ],
    [
      "mask",
      { id: "cu-book2" },
      [
        ["rect", { width: "24", height: "24", fill: "#fff", stroke: "none" }],
        ["path", { d: "M12 12.6v9.4", stroke: "#000", "stroke-width": "1.7", fill: "none" }],
      ],
    ],
    [
      "path",
      {
        mask: "url(#cu-book2)",
        fill: "currentColor",
        d: "M2 10.5c3.2-1 6.7-.6 10 1.5 3.3-2.1 6.8-2.5 10-1.5v9c-3.2-1-6.7-.6-10 1.5-3.3-2.1-6.8-2.5-10-1.5z",
      },
    ],
  ]),
  atSign: strokeIconData([
    ["circle", { cx: "12", cy: "12", r: "4" }],
    ["path", { d: "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" }],
  ]),
  atSignFilled: strokeIconData([
    [
      "mask",
      { id: "cu-at" },
      [
        ["rect", { width: "24", height: "24", fill: "#fff", stroke: "none" }],
        [
          "g",
          {
            transform: "translate(12 12) scale(.6) translate(-12 -12)",
            fill: "none",
            stroke: "#000",
            "stroke-width": "2.8",
            "stroke-linecap": "round",
          },
          [
            ["circle", { cx: "12", cy: "12", r: "4" }],
            ["path", { d: "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" }],
          ],
        ],
      ],
    ],
    ["circle", { mask: "url(#cu-at)", fill: "currentColor", cx: "12", cy: "12", r: "10" }],
  ]),
  access: strokeIconData([
    [
      "path",
      {
        d: "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",
      },
    ],
    ["circle", { cx: "16.5", cy: "7.5", r: ".5", fill: "currentColor" }],
  ]),
  accessFilled: strokeIconData([
    [
      "mask",
      { id: "cu-key" },
      [
        ["rect", { width: "24", height: "24", fill: "#fff", stroke: "none" }],
        ["circle", { cx: "16.5", cy: "7.5", r: "1.7", fill: "#000", stroke: "none" }],
      ],
    ],
    [
      "path",
      {
        mask: "url(#cu-key)",
        fill: "currentColor",
        d: "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",
      },
    ],
  ]),
} as const satisfies Record<string, IconData>;
