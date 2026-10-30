import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enDashboards = {
  dashboardsPage: {
    emptyTitle: "No dashboards yet",
    emptyDescription: "Dashboards created in your tasks will appear here.",
    loadError: "Could not load dashboards: {error}",
    openFocusMode: "Open dashboard in focus mode",
    live: "Live",
    byAuthor: "By {author}",
    updated: "Updated {time}",
    updatedUnknown: "Update time unknown",
    totalLabel: "dashboards",
    searchLabel: "Search dashboards",
    searchPlaceholder: "Search dashboards…",
    authorFilter: "Author",
    allAuthors: "All authors",
    sortLabel: "Sort",
    sortUpdated: "Recently updated",
    sortTitle: "Title A–Z",
    resultCount: "Dashboards: {count}",
    noResultsTitle: "No matching dashboards",
    noResultsDescription: "Try another search or author.",
  },
} satisfies TranslationMap;

export const registerDashboardsEnglish = Object.assign(
  () => {
    Object.assign(en.dashboardsPage, enDashboards.dashboardsPage);
  },
  { catalog: enDashboards },
);
