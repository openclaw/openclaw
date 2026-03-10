import { describe, expect, it } from "vitest";
import {
  classifyMissionControlRequest,
  MISSION_CONTROL_BASE_PATH,
} from "./mission-control-routing.js";

describe("classifyMissionControlRequest", () => {
  it("redirects base path to trailing slash", () => {
    const classified = classifyMissionControlRequest({
      pathname: MISSION_CONTROL_BASE_PATH,
      search: "?foo=bar",
      method: "GET",
    });

    expect(classified).toEqual({
      kind: "redirect",
      location: `${MISSION_CONTROL_BASE_PATH}/?foo=bar`,
    });
  });

  it("serves mission-control subroutes", () => {
    const classified = classifyMissionControlRequest({
      pathname: `${MISSION_CONTROL_BASE_PATH}/routing`,
      search: "",
      method: "GET",
    });

    expect(classified).toEqual({ kind: "serve" });
  });

  it("falls through for unrelated paths", () => {
    const classified = classifyMissionControlRequest({
      pathname: "/healthz",
      search: "",
      method: "GET",
    });

    expect(classified).toEqual({ kind: "not-mission-control" });
  });

  it("returns not-found for non-read method under mission-control path", () => {
    const classified = classifyMissionControlRequest({
      pathname: `${MISSION_CONTROL_BASE_PATH}/incidents`,
      search: "",
      method: "POST",
    });

    expect(classified).toEqual({ kind: "not-found" });
  });

  it("allows ACPX event ingestion post route", () => {
    const classified = classifyMissionControlRequest({
      pathname: `${MISSION_CONTROL_BASE_PATH}/api/acpx-events`,
      search: "",
      method: "POST",
    });

    expect(classified).toEqual({ kind: "serve" });
  });

  it("allows Deb write routes under mission-control api", () => {
    const profileUpdate = classifyMissionControlRequest({
      pathname: `${MISSION_CONTROL_BASE_PATH}/api/deb/profile`,
      search: "",
      method: "PUT",
    });
    const backlogPatch = classifyMissionControlRequest({
      pathname: `${MISSION_CONTROL_BASE_PATH}/api/deb/backlog/task-1`,
      search: "",
      method: "PATCH",
    });

    expect(profileUpdate).toEqual({ kind: "serve" });
    expect(backlogPatch).toEqual({ kind: "serve" });
  });
});
