import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { SessionsPage } from "./sessions-page.tsx";

defineSolidBridge("openclaw-sessions-page", SessionsPage, { properties: ["routeData"] });
