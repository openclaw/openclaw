import { html, nothing, type SVGTemplateResult, type TemplateResult } from "lit";
import { keyboardIconData, toolIconData } from "./icon-data-tools.ts";
import { renderIconData, renderIconNodes } from "./icon-lit.ts";

// Shared Lucide icon shell. Inline presentation attributes keep icons visible
// inside shadow roots that global stylesheet icon rules cannot reach; CSS
// rules still override them where a surface wants a different stroke width.
// Bodies must be svg`` fragments: html`` would parse the shapes outside the
// SVG namespace and they would silently render as nothing.
export function strokeIcon(body: SVGTemplateResult, style?: string): TemplateResult {
  return html`
    <svg
      viewBox="0 0 24 24"
      style=${style ?? nothing}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      ${body}
    </svg>
  `;
}

export const keyboardIconShapes = {
  "⌘": renderIconNodes(keyboardIconData["⌘"]),
  "⌥": renderIconNodes(keyboardIconData["⌥"]),
  "⇧": renderIconNodes(keyboardIconData["⇧"]),
  "⌃": renderIconNodes(keyboardIconData["⌃"]),
  "⏎": renderIconNodes(keyboardIconData["⏎"]),
  "↑": renderIconNodes(keyboardIconData["↑"]),
  "↓": renderIconNodes(keyboardIconData["↓"]),
  "←": renderIconNodes(keyboardIconData["←"]),
  "→": renderIconNodes(keyboardIconData["→"]),
} as const;

export const toolIcons = {
  bookOpenText: renderIconData(toolIconData.bookOpenText),
  mark: renderIconData(toolIconData.mark),
  shieldCheck: renderIconData(toolIconData.shieldCheck),
  shieldX: renderIconData(toolIconData.shieldX),
  cpu: renderIconData(toolIconData.cpu),
  foldVertical: renderIconData(toolIconData.foldVertical),
  wrench: renderIconData(toolIconData.wrench),
  fileCode: renderIconData(toolIconData.fileCode),
  edit: renderIconData(toolIconData.edit),
  home: renderIconData(toolIconData.home),
  cloud: renderIconData(toolIconData.cloud),
  penLine: renderIconData(toolIconData.penLine),
  paperclip: renderIconData(toolIconData.paperclip),
  globe: renderIconData(toolIconData.globe),
  image: renderIconData(toolIconData.image),
  copyImage: renderIconData(toolIconData.copyImage),
  camera: renderIconData(toolIconData.camera),
  cameraOff: renderIconData(toolIconData.cameraOff),
  smartphone: renderIconData(toolIconData.smartphone),
  circleQuestionMark: renderIconData(toolIconData.circleQuestionMark),
  plug: renderIconData(toolIconData.plug),
  circle: renderIconData(toolIconData.circle),
  puzzle: renderIconData(toolIconData.puzzle),
  panelLeft: renderIconData(toolIconData.panelLeft),
  panelLeftClose: renderIconData(toolIconData.panelLeftClose),
  panelLeftOpen: renderIconData(toolIconData.panelLeftOpen),
  chevronDown: renderIconData(toolIconData.chevronDown),
  chevronRight: renderIconData(toolIconData.chevronRight),
  chevronLeft: renderIconData(toolIconData.chevronLeft),
  externalLink: renderIconData(toolIconData.externalLink),
  send: renderIconData(toolIconData.send),
  forward: renderIconData(toolIconData.forward),
  stop: renderIconData(toolIconData.stop),
  pin: renderIconData(toolIconData.pin),
  pinOff: renderIconData(toolIconData.pinOff),
  download: renderIconData(toolIconData.download),
  mic: renderIconData(toolIconData.mic),
  volume2: renderIconData(toolIconData.volume2),
  volumeX: renderIconData(toolIconData.volumeX),
  bookmark: renderIconData(toolIconData.bookmark),
  plus: renderIconData(toolIconData.plus),
  gitBranch: renderIconData(toolIconData.gitBranch),
  gitFork: renderIconData(toolIconData.gitFork),
  gitPullRequest: renderIconData(toolIconData.gitPullRequest),
  gitPullRequestDraft: renderIconData(toolIconData.gitPullRequestDraft),
  gitPullRequestClosed: renderIconData(toolIconData.gitPullRequestClosed),
  gitMerge: renderIconData(toolIconData.gitMerge),
  terminal: renderIconData(toolIconData.terminal),
  squareTerminal: renderIconData(toolIconData.squareTerminal),
  listTree: renderIconData(toolIconData.listTree),
  claw: renderIconData(toolIconData.claw),
  spark: renderIconData(toolIconData.spark),
  lobster: renderIconData(toolIconData.lobster),
  circleUser: renderIconData(toolIconData.circleUser),
  bell: renderIconData(toolIconData.bell),
  palette: renderIconData(toolIconData.palette),
  flaskConical: renderIconData(toolIconData.flaskConical),
  badgeCheck: renderIconData(toolIconData.badgeCheck),
  refresh: renderIconData(toolIconData.refresh),
  rotateCcw: renderIconData(toolIconData.rotateCcw),
  trash: renderIconData(toolIconData.trash),
  eye: renderIconData(toolIconData.eye),
  eyeOff: renderIconData(toolIconData.eyeOff),
  arrowUpDown: renderIconData(toolIconData.arrowUpDown),
  panelRightOpen: renderIconData(toolIconData.panelRightOpen),
  panelRightClose: renderIconData(toolIconData.panelRightClose),
  columns2: renderIconData(toolIconData.columns2),
  panelBottomOpen: renderIconData(toolIconData.panelBottomOpen),
  panelBottomClose: renderIconData(toolIconData.panelBottomClose),
  maximize: renderIconData(toolIconData.maximize),
  minimize: renderIconData(toolIconData.minimize),
} as const;
