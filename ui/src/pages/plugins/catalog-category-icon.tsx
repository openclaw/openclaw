import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";
import { StrokeIcon } from "../../components/solid/stroke-icon.tsx";

function CategoryStrokeIcon(props: { children: JSX.Element }) {
  return <StrokeIcon> {props.children}</StrokeIcon>;
}

// Category-only SVGs stay in the deferred Plugins page, outside the startup icon registry.
const CATEGORY_ICONS: Readonly<Record<string, () => JSX.Element>> = {
  activity: () => <Icon name="activity" />,
  "book-open": () => <Icon name="book" />,
  brain: () => <Icon name="brain" />,
  bot: () => <Icon name="bot" />,
  database: () => (
    <CategoryStrokeIcon>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </CategoryStrokeIcon>
  ),
  "git-branch": () => <Icon name="gitPullRequest" />,
  globe: () => <Icon name="globe" />,
  "message-circle": () => <Icon name="messageSquare" />,
  "message-square": () => <Icon name="messageSquare" />,
  mic: () => <Icon name="mic" />,
  monitor: () => <Icon name="monitor" />,
  package: () => <Icon name="box" />,
  palette: () => <Icon name="palette" />,
  shield: () => <Icon name="shield" />,
  wrench: () => <Icon name="settings" />,
  plug: () => <Icon name="plug" />,
  "code-xml": () => (
    <CategoryStrokeIcon>
      <path d="m18 16 4-4-4-4" />
      <path d="m6 8-4 4 4 4" />
      <path d="m14.5 4-5 16" />
    </CategoryStrokeIcon>
  ),
  server: () => <Icon name="server" />,
  files: () => (
    <CategoryStrokeIcon>
      <path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
      <path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z" />
      <path d="M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1" />
    </CategoryStrokeIcon>
  ),
  inbox: () => <Icon name="inbox" />,
  "list-todo": () => (
    <CategoryStrokeIcon>
      <path d="M13 5h8" />
      <path d="M13 12h8" />
      <path d="M13 19h8" />
      <path d="m3 17 2 2 4-4" />
      <rect x="3" y="4" width="6" height="6" rx="1" />
    </CategoryStrokeIcon>
  ),
  "calendar-days": () => (
    <CategoryStrokeIcon>
      <path d="M8 2v3" />
      <path d="M16 2v3" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 13h.01" />
      <path d="M12 13h.01" />
      <path d="M16 13h.01" />
      <path d="M8 17h.01" />
      <path d="M12 17h.01" />
      <path d="M16 17h.01" />
    </CategoryStrokeIcon>
  ),
  "wallet-cards": () => (
    <CategoryStrokeIcon>
      <path d="M3 11h3.75a2 2 0 0 1 1.6.8l.45.6a4 4 0 0 0 6.4 0l.45-.6a2 2 0 0 1 1.6-.8H21" />
      <path d="M3 7h18" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </CategoryStrokeIcon>
  ),
  megaphone: () => (
    <CategoryStrokeIcon>
      <path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
      <path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14" />
      <path d="M8 6v8" />
    </CategoryStrokeIcon>
  ),
  "chart-no-axes-combined": () => (
    <CategoryStrokeIcon>
      <path d="M12 16v5" />
      <path d="M16 14.639V21" />
      <path d="M20 10.656V21" />
      <path d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15" />
      <path d="M4 18.463V21" />
      <path d="M8 14.656V21" />
    </CategoryStrokeIcon>
  ),
  workflow: () => (
    <CategoryStrokeIcon>
      <rect width="8" height="8" x="3" y="3" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
      <rect width="8" height="8" x="13" y="13" rx="2" />
    </CategoryStrokeIcon>
  ),
  search: () => <Icon name="search" />,
};

export function categoryIcon(icon: string | undefined): JSX.Element {
  const render = icon && Object.hasOwn(CATEGORY_ICONS, icon) && CATEGORY_ICONS[icon];
  return render ? render() : <Icon name="box" />;
}
