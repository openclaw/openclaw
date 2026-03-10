import { isReadHttpMethod } from "./control-ui-http-utils.js";

export const MISSION_CONTROL_BASE_PATH = "/mission-control" as const;
const MISSION_CONTROL_ACPX_EVENTS_PATH = `${MISSION_CONTROL_BASE_PATH}/api/acpx-events`;
const MISSION_CONTROL_DEB_API_PREFIX = `${MISSION_CONTROL_BASE_PATH}/api/deb`;

export type MissionControlRequestClassification =
  | { kind: "not-mission-control" }
  | { kind: "not-found" }
  | { kind: "redirect"; location: string }
  | { kind: "serve" };

export function classifyMissionControlRequest(params: {
  pathname: string;
  search: string;
  method: string | undefined;
}): MissionControlRequestClassification {
  const { pathname, search, method } = params;

  if (pathname === MISSION_CONTROL_BASE_PATH) {
    if (!isReadHttpMethod(method)) {
      return { kind: "not-mission-control" };
    }
    return {
      kind: "redirect",
      location: `${MISSION_CONTROL_BASE_PATH}/${search}`,
    };
  }

  if (!pathname.startsWith(`${MISSION_CONTROL_BASE_PATH}/`)) {
    return { kind: "not-mission-control" };
  }

  if (!isReadHttpMethod(method)) {
    if (method === "POST" && pathname === MISSION_CONTROL_ACPX_EVENTS_PATH) {
      return { kind: "serve" };
    }

    if (
      pathname === MISSION_CONTROL_DEB_API_PREFIX ||
      pathname.startsWith(`${MISSION_CONTROL_DEB_API_PREFIX}/`)
    ) {
      return { kind: "serve" };
    }

    return { kind: "not-found" };
  }

  return { kind: "serve" };
}
