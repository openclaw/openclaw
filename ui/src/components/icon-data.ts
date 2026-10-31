import { brandIconData } from "./icon-data-brand.ts";
import { statusIconPaths } from "./icon-data-status.ts";
import { keyboardIconData, toolIconData } from "./icon-data-tools.ts";
import { strokeIconData, strokePathData, type IconData } from "./icon-data-types.ts";

const ZAP_POINTS = "13 2 3 14 12 14 11 22 21 10 12 10 13 2";
// Rear bolt of zapDouble: the stroked zap outline minus the front bolt and a
// small up-left gap, so the pair keeps its separation on any background
// without masks, ids, or a background-colored outline.
const ZAP_DOUBLE_REAR_PATH =
  "M13.99 1.87 13.92 1.62 13.8 1.4 13.62 1.21 13.4 1.08 13.15 1.01 12.9 1.01 12.65 1.06 12.42 1.19 12.23 1.36 2.23 13.36 2.1 13.57 2.02 13.81 2 14.06 2.05 14.31 2.15 14.53 2.31 14.73 2.52 14.88 2.75 14.97 3 15 7.78 15 13.2 8.5 13.99 2.12ZM10.01 21.88 10.01 22.13 10.08 22.38 10.2 22.6 10.38 22.79 10.6 22.92 10.85 22.99 11.1 22.99 11.35 22.94 11.58 22.81 11.77 22.64 12.42 21.86ZM21.77 10.64 21.9 10.43 21.98 10.19 22 9.94 21.95 9.69 21.85 9.47 21.69 9.27 21.48 9.12 21.25 9.03 21 9 17.42 9 16.69 14.83 18.28 14.83Z";

export const iconData = {
  share: strokeIconData([
    ["circle", { cx: "18", cy: "5", r: "3" }],
    ["circle", { cx: "6", cy: "12", r: "3" }],
    ["circle", { cx: "18", cy: "19", r: "3" }],
    ["line", { x1: "8.59", x2: "15.42", y1: "13.51", y2: "17.49" }],
    ["line", { x1: "15.41", x2: "8.59", y1: "6.51", y2: "10.49" }],
  ]),
  github: brandIconData.github,
  incognito: strokePathData(
    "m7 7 1.5-4.5 3.5 1 3.5-1L17 7M5 7h14",
    "M8 10v3c0 3 1.8 5 4 5s4-2 4-5v-3M8 14H6m10 0h2",
    "m2.5 9.5-1 3a2.5 2.5 0 0 0 5 0l-1-3-1.5 2-1.5-2Z",
    "m18.5 9.5-1 3a2.5 2.5 0 0 0 5 0l-1-3-1.5 2-1.5-2Z",
    "m10 18-2 3 4-1 4 1-2-3",
    "M10.5 11h.01m2.99 0h.01",
  ),
  repeat: strokePathData(
    "m17 2 4 4-4 4",
    "M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4",
    "M21 13v2a3 3 0 0 1-3 3H3",
  ),
  layers: strokePathData("m12 3 10 5-10 5L2 8Z", "m2 12 10 5 10-5M2 16l10 5 10-5"),
  messageCircle: strokePathData(
    "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
  ),
  messageSquare: strokePathData("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"),
  messageSquarePlus: strokePathData(
    "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    "M12 7v6",
    "M9 10h6",
  ),
  messageCircleOff: strokePathData(
    "m2 2 20 20",
    "M4.93 4.929a10 10 0 0 0-1.938 11.412 2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 0 0 11.302-1.989",
    "M8.35 2.69A10 10 0 0 1 21.3 15.65",
  ),
  layoutGrid: strokeIconData([
    ["rect", { width: "7", height: "7", x: "3", y: "3", rx: "1" }],
    ["rect", { width: "7", height: "7", x: "14", y: "3", rx: "1" }],
    ["rect", { width: "7", height: "7", x: "14", y: "14", rx: "1" }],
    ["rect", { width: "7", height: "7", x: "3", y: "14", rx: "1" }],
  ]),
  barChart: strokeIconData([
    ["line", { x1: "12", x2: "12", y1: "20", y2: "10" }],
    ["line", { x1: "18", x2: "18", y1: "20", y2: "4" }],
    ["line", { x1: "6", x2: "6", y1: "20", y2: "16" }],
  ]),
  layoutDashboard: strokeIconData([
    ["rect", { width: "7", height: "9", x: "3", y: "3", rx: "1" }],
    ["rect", { width: "7", height: "5", x: "14", y: "3", rx: "1" }],
    ["rect", { width: "7", height: "9", x: "14", y: "12", rx: "1" }],
    ["rect", { width: "7", height: "5", x: "3", y: "16", rx: "1" }],
  ]),
  coins: strokeIconData([
    ["circle", { cx: "8", cy: "8", r: "6" }],
    ["path", { d: "M18.09 10.37A6 6 0 1 1 10.34 18" }],
    ["path", { d: "M7 6h1v4" }],
    ["path", { d: "m16.71 13.88.7.71-2.82 2.82" }],
  ]),
  activity: strokePathData("M22 12h-4l-3 9L9 3l-3 9H2"),
  clock: strokeIconData([
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["polyline", { points: "12 6 12 12 16 14" }],
  ]),
  circleX: strokeIconData([
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "m15 9-6 6" }],
    ["path", { d: "m9 9 6 6" }],
  ]),
  arrowLeftRight: strokePathData("m8 3-4 4 4 4", "M4 7h16", "m16 21 4-4-4-4", "M20 17H4"),
  arrowUpRight: strokePathData("M7 17 17 7", "M7 7h10v10"),
  link: strokePathData(
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  ),
  radio: strokeIconData([
    ["circle", { cx: "12", cy: "12", r: "2" }],
    [
      "path",
      {
        d: "M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14",
      },
    ],
  ]),
  fileText: strokeIconData([
    ["path", { d: "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["line", { x1: "16", x2: "8", y1: "13", y2: "13" }],
    ["line", { x1: "16", x2: "8", y1: "17", y2: "17" }],
    ["line", { x1: "10", x2: "8", y1: "9", y2: "9" }],
  ]),
  file: strokeIconData([
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
  ]),
  // At 18px the fold collides with the plus; keep the cut corner without the fold line.
  fileDiff: strokePathData(
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.7.71l3.59 3.58A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M9 10h6",
    "M12 13V7",
    "M9 17h6",
  ),
  diff: strokePathData("M12 3v14", "M5 10h14", "M5 21h14"),
  braces: strokePathData(
    "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1",
    "M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
  ),
  mail: strokeIconData([
    ["path", { d: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" }],
    ["polyline", { points: "22,6 12,13 2,6" }],
  ]),
  // Queued messages use the rising tray arrow; the clock belongs to automations.
  outbox: strokeIconData([
    ["polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }],
    ["path", { d: "M2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6" }],
    ["path", { d: "M12 10V3" }],
    ["path", { d: "m8 6 4-4 4 4" }],
  ]),
  inbox: strokeIconData([
    ["polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }],
    [
      "path",
      {
        d: "m5.45 5.11-3.45 6.89v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89a2 2 0 0 0-1.79-1.11h-9.52a2 2 0 0 0-1.79 1.11z",
      },
    ],
  ]),
  star: strokeIconData([
    [
      "polygon",
      {
        points:
          "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2",
      },
    ],
  ]),
  wandSparkles: strokePathData(
    "M15 4V2",
    "M15 16v-2",
    "M8 9h2",
    "M20 9h2",
    "M17.8 11.8 19 13",
    "M15 9h0",
    "M17.8 6.2 19 5",
    "m3 21 9-9",
    "M12.2 6.2 11 5",
  ),
  chrome: strokeIconData([
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["circle", { cx: "12", cy: "12", r: "4" }],
    ["line", { x1: "21.17", y1: "8", x2: "12", y2: "8" }],
    ["line", { x1: "3.95", y1: "6.06", x2: "8.54", y2: "14" }],
    ["line", { x1: "10.88", y1: "21.94", x2: "15.46", y2: "14" }],
  ]),
  panelsTopLeft: strokeIconData([
    ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2", ry: "2" }],
    ["line", { x1: "3", y1: "9", x2: "21", y2: "9" }],
    ["line", { x1: "9", y1: "21", x2: "9", y2: "9" }],
  ]),
  box: strokeIconData([
    [
      "path",
      {
        d: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
      },
    ],
    ["polyline", { points: "3.27 6.96 12 12.01 20.73 6.96" }],
    ["line", { x1: "12", y1: "22.08", x2: "12", y2: "12" }],
  ]),
  music: strokeIconData([
    ["path", { d: "M9 18V5l12-2v13" }],
    ["circle", { cx: "6", cy: "18", r: "3" }],
    ["circle", { cx: "18", cy: "16", r: "3" }],
  ]),
  asterisk: strokePathData(
    "M12 2v6",
    "m4.93 10.93 4.24 4.24",
    "M2 12h6",
    "m4.93 13.07 4.24-4.24",
    "M12 22v-6",
    "m19.07 13.07-4.24-4.24",
    "M22 12h-6",
    "m19.07 10.93-4.24 4.24",
  ),
  zap: strokeIconData([["polygon", { points: ZAP_POINTS }]]),
  zapDouble: {
    ...strokeIconData([
      [
        "path",
        {
          d: ZAP_DOUBLE_REAR_PATH,
          fill: "var(--icon-secondary, color-mix(in srgb, var(--accent) 60%, var(--muted)))",
          stroke: "none",
        },
      ],
      [
        "polygon",
        {
          points: ZAP_POINTS,
          transform: "translate(3.43 6.86)",
          fill: "var(--icon-primary, color-mix(in srgb, var(--accent) 75%, var(--text-strong)))",
          stroke: "var(--icon-primary, color-mix(in srgb, var(--accent) 75%, var(--text-strong)))",
        },
      ],
    ]),
    attributes: { ...strokeIconData([]).attributes, viewBox: "0 0 27.43 30.86" },
  },
  monitor: strokeIconData([
    ["rect", { width: "20", height: "14", x: "2", y: "3", rx: "2" }],
    ["line", { x1: "8", x2: "16", y1: "21", y2: "21" }],
    ["line", { x1: "12", x2: "12", y1: "17", y2: "21" }],
  ]),
  monitorSmartphone: strokeIconData([
    ["path", { d: "M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" }],
    ["path", { d: "M10 19v-3.96 3.15" }],
    ["path", { d: "M7 19h5" }],
    ["rect", { width: "6", height: "10", x: "16", y: "12", rx: "2" }],
  ]),
  server: strokeIconData([
    ["rect", { width: "20", height: "8", x: "2", y: "2", rx: "2", ry: "2" }],
    ["rect", { width: "20", height: "8", x: "2", y: "14", rx: "2", ry: "2" }],
    ["line", { x1: "6", x2: "6.01", y1: "6", y2: "6" }],
    ["line", { x1: "6", x2: "6.01", y1: "18", y2: "18" }],
  ]),
  sun: strokeIconData([
    ["circle", { cx: "12", cy: "12", r: "4" }],
    ["path", { d: "M12 2v2" }],
    ["path", { d: "M12 20v2" }],
    ["path", { d: "m4.93 4.93 1.41 1.41" }],
    ["path", { d: "m17.66 17.66 1.41 1.41" }],
    ["path", { d: "M2 12h2" }],
    ["path", { d: "M20 12h2" }],
    ["path", { d: "m6.34 17.66-1.41 1.41" }],
    ["path", { d: "m19.07 4.93-1.41 1.41" }],
  ]),
  moon: strokePathData("M12 3a6.5 6.5 0 0 0 9 9 9 9 0 1 1-9-9Z"),
  settings: strokeIconData([
    [
      "path",
      {
        d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      },
    ],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ]),
  bug: strokePathData(
    "m8 2 1.88 1.88",
    "M14.12 3.88 16 2",
    "M9 7.13v-1a3.003 3.003 0 1 1 6 0v1",
    "M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6",
    "M12 20v-9",
    "M6.53 9C4.6 8.8 3 7.1 3 5",
    "M6 13H2",
    "M3 21c0-2.1 1.7-3.9 3.8-4",
    "M20.97 5c0 2.1-1.6 3.8-3.5 4",
    "M22 13h-4",
    "M17.2 17c2.1.1 3.8 1.9 3.8 4",
  ),
  scrollText: strokePathData(
    "M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4",
    "M19 17V5a2 2 0 0 0-2-2H4",
    "M15 8h-5",
    "M15 12h-5",
  ),
  hash: strokePathData("M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"),
  folder: strokePathData(
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  ),
  folders: strokePathData(
    "M20 5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 1 1.2.6l.6.8a1.5 1.5 0 0 0 1.2.6z",
    "M3 8.268a2 2 0 0 0-1 1.738V19a2 2 0 0 0 2 2h11a2 2 0 0 0 1.732-1",
  ),
  kanban: strokeIconData([
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M8 7v7" }],
    ["path", { d: "M12 7v4" }],
    ["path", { d: "M16 7v9" }],
  ]),
  bot: strokeIconData([
    ["path", { d: "M12 8V4H8" }],
    ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
    ["path", { d: "M2 14h2" }],
    ["path", { d: "M20 14h2" }],
    ["path", { d: "M15 13v2" }],
    ["path", { d: "M9 13v2" }],
  ]),
  userPlus: strokeIconData([
    ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }],
    ["circle", { cx: "9", cy: "7", r: "4" }],
    ["path", { d: "M20 8v6" }],
    ["path", { d: "M23 11h-6" }],
  ]),
  users: strokeIconData([
    ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }],
    ["circle", { cx: "9", cy: "7", r: "4" }],
    ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }],
    ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }],
  ]),
  shieldQuestion: strokePathData(
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3",
    "M12 17h.01",
  ),
  shield: strokePathData(
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
  ),
  shieldEllipsis: strokePathData(
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "M8 12h.01",
    "M12 12h.01",
    "M16 12h.01",
  ),
  shieldLock: strokeIconData([
    [
      "path",
      {
        d: "M20 9.807V6a1 1 0 0 0-1-1c-2 0-4.49-1.19-6.24-2.72a1.17 1.17 0 0 0-1.52 0C9.5 3.8 7 5 5 5a1 1 0 0 0-1 1v7c0 3.88 2.107 6.254 5 7.796",
      },
    ],
    ["path", { d: "M19 17v-2a2 2 0 0 0-4 0v2" }],
    ["rect", { x: "13", y: "17", width: "8", height: "5", rx: "1" }],
  ]),
  shieldCog: strokeIconData([
    ["path", { d: "m10.929 14.467-.383.924" }],
    ["path", { d: "M10.929 8.923 10.546 8" }],
    ["path", { d: "M13.225 8.923 13.608 8" }],
    ["path", { d: "m13.607 15.391-.382-.924" }],
    ["path", { d: "m14.849 10.547.923-.383" }],
    ["path", { d: "m14.849 12.843.923.383" }],
    [
      "path",
      {
        d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
      },
    ],
    ["path", { d: "m9.305 10.547-.923-.383" }],
    ["path", { d: "m9.305 12.843-.923.383" }],
    ["circle", { cx: "12.077", cy: "11.695", r: "3" }],
  ]),
  shieldAlert: strokePathData(
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "M12 8v4",
    "M12 16h.01",
  ),
  menu: strokeIconData([
    ["line", { x1: "4", x2: "20", y1: "12", y2: "12" }],
    ["line", { x1: "4", x2: "20", y1: "6", y2: "6" }],
    ["line", { x1: "4", x2: "20", y1: "18", y2: "18" }],
  ]),
  x: strokePathData(...statusIconPaths.x),
  // Lucide circle-dashed (ISC).
  circleDashed: strokePathData(
    "M10.1 2.182a10 10 0 0 1 3.8 0",
    "M13.9 21.818a10 10 0 0 1-3.8 0",
    "M17.609 3.721a10 10 0 0 1 2.69 2.7",
    "M2.182 13.9a10 10 0 0 1 0-3.8",
    "M20.279 17.609a10 10 0 0 1-2.7 2.69",
    "M21.818 10.1a10 10 0 0 1 0 3.8",
    "M3.721 6.391a10 10 0 0 1 2.7-2.69",
    "M6.391 20.279a10 10 0 0 1-2.69-2.7",
  ),
  check: strokePathData("M20 6 9 17l-5-5"),
  info: strokeIconData([
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M12 16v-4" }],
    ["path", { d: "M12 8h.01" }],
  ]),
  square: strokeIconData([["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }]]),
  play: strokeIconData([["polygon", { points: "6 3 20 12 6 21 6 3" }]]),
  pause: strokeIconData([
    ["rect", { x: "14", y: "4", width: "4", height: "16", rx: "1" }],
    ["rect", { x: "6", y: "4", width: "4", height: "16", rx: "1" }],
  ]),
  target: strokeIconData([
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["circle", { cx: "12", cy: "12", r: "6" }],
    ["circle", { cx: "12", cy: "12", r: "2" }],
  ]),
  switchCamera: strokePathData(
    "M11 19H6.5a4.5 4.5 0 0 1 0-9H8",
    "m8 16 3 3-3 3",
    "M13 5h4.5a4.5 4.5 0 0 1 0 9H16",
    "m16 8-3-3 3-3",
  ),
  archive: strokeIconData([
    ["rect", { width: "20", height: "5", x: "2", y: "3", rx: "1" }],
    ["path", { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" }],
    ["path", { d: "M10 12h4" }],
  ]),
  archiveRestore: strokeIconData([
    ["rect", { width: "20", height: "5", x: "2", y: "3", rx: "1" }],
    ["path", { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" }],
    ["path", { d: "m9 15 3-3 3 3" }],
    ["path", { d: "M12 12v6" }],
  ]),
  alertTriangle: strokePathData(...statusIconPaths.alertTriangle),
  globeOff: strokePathData(
    "M10.114 4.462A14.5 14.5 0 0 1 12 2a10 10 0 0 1 9.313 13.643",
    "M15.557 15.556A14.5 14.5 0 0 1 12 22 10 10 0 0 1 4.929 4.929",
    "M15.892 10.234A14.5 14.5 0 0 0 12 2a10 10 0 0 0-3.643.687",
    "M17.656 12H22",
    "M19.071 19.071A10 10 0 0 1 12 22 14.5 14.5 0 0 1 8.44 8.45",
    "M2 12h10",
    "m2 2 20 20",
  ),
  hand: strokePathData(
    "M18 11V6a2 2 0 0 0-4 0v5",
    "M14 10V4a2 2 0 0 0-4 0v6",
    "M10 10.5V6a2 2 0 0 0-4 0v8",
    "M6 14v-2a2 2 0 0 0-4 0v4c0 4.4 3.6 8 8 8h2c4.4 0 8-3.6 8-8v-5a2 2 0 0 0-4 0v2",
  ),
  key: strokeIconData([
    ["circle", { cx: "7.5", cy: "15.5", r: "5.5" }],
    ["path", { d: "m21 2-9.6 9.6" }],
    ["path", { d: "m15.5 7.5 3 3L22 7l-3-3" }],
  ]),
  flag: strokePathData("M5 22V4", "M5 4c5-4 9 4 14 0v11c-5 4-9-4-14 0"),
  lock: strokeIconData([
    ["rect", { width: "18", height: "11", x: "3", y: "11", rx: "2" }],
    ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }],
  ]),
  // Lucide pencil-line (ISC), matching the native 24px/stroke-2 icon contract.
  pencilLine: strokePathData(
    "M13 21h8",
    "m15 5 4 4",
    "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
  ),
  pencil: strokePathData(
    "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
    "m15 5 4 4",
  ),
  pipette: strokePathData(
    "m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12",
    "m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z",
    "m2 22 .414-.414",
  ),
  pencilSparkles: strokePathData(
    "M10 3H8",
    "m15.007 5.008 3.987 3.986",
    "M20 15v4",
    "M21.174 6.813a2.82 2.82 0 0 0-3.986-3.987L3.842 16.175a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
    "M22 17h-4",
    "M4 5v4",
    "M6 7H2",
    "M9 2v2",
  ),
  layoutComfortable: strokeIconData([
    ["rect", { width: "16", height: "5", x: "4", y: "4", rx: "1.5" }],
    ["rect", { width: "16", height: "5", x: "4", y: "15", rx: "1.5" }],
    ["line", { x1: "7", x2: "16", y1: "7", y2: "7" }],
    ["line", { x1: "7", x2: "16", y1: "18", y2: "18" }],
  ]),
  layoutCompact: strokeIconData([
    ["rect", { width: "16", height: "3", x: "4", y: "4", rx: "1" }],
    ["rect", { width: "16", height: "3", x: "4", y: "9", rx: "1" }],
    ["rect", { width: "16", height: "3", x: "4", y: "14", rx: "1" }],
    ["rect", { width: "16", height: "3", x: "4", y: "19", rx: "1" }],
  ]),
  list: strokePathData("M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"),
  listFilter: strokePathData("M3 6h18", "M7 12h10", "M10 18h4"),
  // Filled dots opt out of the shared fill="none" stroke shell.
  gripVertical: strokeIconData([
    ["circle", { cx: "9", cy: "6", r: "1.1", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "9", cy: "12", r: "1.1", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "9", cy: "18", r: "1.1", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "15", cy: "6", r: "1.1", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "15", cy: "12", r: "1.1", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "15", cy: "18", r: "1.1", fill: "currentColor", stroke: "none" }],
  ]),
  arrowDown: strokeIconData(keyboardIconData["↓"]),
  arrowUp: strokeIconData(keyboardIconData["↑"]),
  audioLines: strokePathData("M2 10v3", "M6 6v11", "M10 3v18", "M14 8v7", "M18 5v13", "M22 10v3"),
  chevronUp: strokeIconData(keyboardIconData["⌃"]),
  chevronsUpDown: strokePathData("m7 15 5 5 5-5", "m7 9 5-5 5 5"),
  arrowRight: strokeIconData(keyboardIconData["→"]),
  arrowLeft: strokeIconData(keyboardIconData["←"]),
  cornerDownLeft: strokeIconData(keyboardIconData["⏎"]),
  cornerUpLeft: strokeIconData([
    ["polyline", { points: "9 14 4 9 9 4" }],
    ["path", { d: "M20 20v-7a4 4 0 0 0-4-4H4" }],
  ]),
  cornerDownRight: strokeIconData([
    ["polyline", { points: "15 10 20 15 15 20" }],
    ["path", { d: "M4 4v7a4 4 0 0 0 4 4h12" }],
  ]),
  copy: strokeIconData([
    ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
  ]),
  search: strokeIconData([
    ["circle", { cx: "11", cy: "11", r: "8" }],
    ["path", { d: "m21 21-4.3-4.3" }],
  ]),
  wrapText: strokePathData("M3 6h18", "M3 12h15a3 3 0 1 1 0 6h-4", "m16 16-2 2 2 2", "M3 18h7"),
  brain: strokePathData(
    "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z",
    "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z",
    "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4",
    "M17.599 6.5a3 3 0 0 0 .399-1.375",
    "M6.003 5.125A3 3 0 0 0 6.401 6.5",
    "M3.477 10.896a4 4 0 0 1 .585-.396",
    "M19.938 10.5a4 4 0 0 1 .585.396",
    "M6 18a4 4 0 0 1-1.967-.516",
    "M19.967 17.484A4 4 0 0 1 18 18",
  ),
  book: strokePathData("M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"),
  loader: strokePathData(
    "M12 2v4",
    "m16.2 7.8 2.9-2.9",
    "M18 12h4",
    "m16.2 16.2 2.9 2.9",
    "M12 18v4",
    "m4.9 19.1 2.9-2.9",
    "M2 12h4",
    "m4.9 4.9 2.9 2.9",
  ),
  calendarClock: strokeIconData([
    ["path", { d: "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" }],
    ["path", { d: "M16 2v4" }],
    ["path", { d: "M8 2v4" }],
    ["path", { d: "M3 10h5" }],
    ["path", { d: "M17.5 17.5 16 16.3V14" }],
    ["circle", { cx: "16", cy: "16", r: "6" }],
  ]),
  listChecks: strokePathData("m3 17 2 2 4-4", "m3 7 2 2 4-4", "M13 6h8", "M13 12h8", "M13 18h8"),
  moreHorizontal: strokeIconData([
    ["circle", { cx: "5", cy: "12", r: "1" }],
    ["circle", { cx: "12", cy: "12", r: "1" }],
    ["circle", { cx: "19", cy: "12", r: "1" }],
  ]),
  ...toolIconData,
} as const satisfies Record<string, IconData>;

export type IconName = keyof typeof iconData;
