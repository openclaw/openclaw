import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enBoardDocument = {
  board: {
    label: "Session dashboard",
    tabsLabel: "Dashboard tabs",
    moreTabs: "More dashboard tabs",
    gridLabel: "Dashboard widgets",
    emptyTitle: "No widgets yet.",
    emptyHint: "Ask your agent to pin a status card here.",
    actionFailed: "Couldn’t save the dashboard change. Try again.",
    actionInProgress: "Another dashboard change is still being saved.",
    lobby: {
      label: "Lobby components",
      settings: "Component access",
      permissions: "Component access",
      permissionScope:
        "Choose what your components can access. You can change these permissions here at any time.",
      executorRequirements: "Devices must be connected and have their system permissions enabled.",
      readOnlyPermissions: "This connection can view permissions but cannot change them.",
      noPermissions: "No additional access requested.",
      accessDetails: "Access details",
      capability: "Capability",
      anyValue: "Any",
      websites: "Websites",
      runAutomation: "Run an automation",
      messageAgent: "Send a message to your agent",
      workflowData: "Read GitHub workflow runs.",
      fields: "Fields",
      connectedAccountAccess:
        "Uses your agent’s connected account. This data is visible to people who can view this conversation.",
      revoke: "Revoke access",
      deny: "Deny access",
      permissionState: {
        none: "No approval required",
        pending: "Awaiting approval",
        granted: "Access allowed",
        rejected: "Access denied",
      },
      empty: "Ask your agent to create something for you here.",
      open: "Open {title}",
      back: "Back to Lobby",
      expand: "Expand {title}",
      collapse: "Collapse {title}",
    },
    announcement: {
      moved: "Moved {title}.",
      resized: "Resized {title}.",
      removed: "Removed {title}.",
      granted: "Widget access allowed.",
      rejected: "Widget access rejected.",
    },
    widget: {
      cellLabel:
        "Dashboard widget: {title}. Use arrow keys to navigate. Hold Alt and press an arrow key to move it.",
      moveHandle: "Move {title}",
      resizeHandle: en.board.widget.resizeHandle,
      menuLabel: en.board.widget.menuLabel,
      moveToTab: en.board.widget.moveToTab,
      noOtherTabs: en.board.widget.noOtherTabs,
      resize: en.board.widget.resize,
      autoHeight: en.board.widget.autoHeight,
      remove: en.board.widget.remove,
      kindMcp: "MCP",
      kindHtml: "HTML",
      kindPlugin: "Plugin",
      kindReport: "Report",
      kindWebsite: "Website",
      kindBrowserDashboard: "Browser dashboard",
      pluginLoading: "Loading plugin widget…",
      disabledPlugin: "Widget from disabled plugin {pluginId}",
    },
  },
} satisfies TranslationMap;

export const registerBoardDocumentEnglish = Object.assign(
  () => {
    const { announcement, widget, ...labels } = enBoardDocument.board;
    Object.assign(en.board, labels);
    Object.assign(en.board.announcement, announcement);
    Object.assign(en.board.widget, widget);
  },
  { catalog: enBoardDocument },
);
