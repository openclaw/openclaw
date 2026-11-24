import type { ControlUiBrowserFamily } from "../shared/control-ui-browser-requirements.js";

export type ControlUiBrowserInstallation = {
  family: ControlUiBrowserFamily;
  /** Fixed display name supplied by the platform adapter, never raw OS output. */
  name: string;
  version: string;
  /** Browser application only: no automation profiles, URL placeholders, or credentials. */
  command: string[];
};

export type ControlUiBrowserDiscovery = {
  defaultBrowser?: ControlUiBrowserInstallation;
  /** Already ordered deterministically by the platform adapter. */
  alternatives: ControlUiBrowserInstallation[];
  headless?: boolean;
};
