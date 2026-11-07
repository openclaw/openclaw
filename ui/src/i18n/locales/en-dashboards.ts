import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enDashboards = {
  dashboardsPage: {
    emptyTitle: "No dashboards yet",
    emptyDescription: "Dashboards created in your sessions appear here.",
    loadError: "Couldn’t load dashboards. Try again. {error}",
    openFocusMode: "Open dashboard in focus mode",
    running: "Updating now",
    you: "You",
    updatedLabel: "Updated",
    updatedUnknown: "Update time unknown",
    searchLabel: "Search dashboards",
    searchPlaceholder: "Search dashboards…",
    authorFilter: "Author",
    allAuthors: "All authors",
    display: "Display",
    viewGrid: "Grid",
    viewList: "List",
    ordering: "Ordering",
    grouping: "Grouping",
    groupNone: "No grouping",
    groupUpdated: "Last updated",
    groupAuthor: "Author",
    groupToday: "Today",
    groupThisWeek: "This week",
    groupEarlier: "Earlier",
    sortUpdated: "Recently updated",
    sortTitle: "Title A–Z",
    resultCount: "Dashboards: {count}",
    noResultsTitle: "No dashboards match your search.",
    noResultsDescription: "Try another search or author.",
  },
} satisfies TranslationMap;

export const registerDashboardsEnglish = Object.assign(
  () => {
    Object.assign(en.dashboardsPage, enDashboards.dashboardsPage);
  },
  { catalog: enDashboards },
);
