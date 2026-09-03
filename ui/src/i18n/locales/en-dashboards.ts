import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Register route copy with the lazy Dashboards page instead of charging every
// Control UI startup for labels that only this page renders.
const enDashboards = {
  dashboardsPage: {
    emptyTitle: "No dashboards yet",
    emptyDescription: "Dashboards created in your tasks will appear here.",
    loadError: "Could not load dashboards: {error}",
    openFocusMode: "Open in focus mode",
    live: "Live",
    byAuthor: "By {author}",
    updated: "Updated {time}",
    updatedUnknown: "Update time unknown",
    created: "Created {time}",
    createdUnknown: "Creation time unknown",
    totalLabel: "dashboards",
    searchLabel: "Search dashboards",
    searchPlaceholder: "Search dashboards…",
    authorFilter: "Author",
    allAuthors: "All authors",
    sortLabel: "Sort",
    sortUpdated: "Recently updated",
    sortCreated: "Recently created",
    sortTitle: "Title A–Z",
    viewLabel: "View",
    viewCards: "Cards",
    viewList: "List",
    previewEmpty: "No widgets yet",
    previewUnavailable: "Preview unavailable",
    resultCount: "{count} dashboards",
    noResultsTitle: "No matching dashboards",
    noResultsDescription: "Try another search or author.",
  },
} satisfies TranslationMap;

export const registerDashboardsEnglish = Object.assign(
  () => {
    en.dashboardsPage = enDashboards.dashboardsPage;
  },
  { catalog: enDashboards },
);
