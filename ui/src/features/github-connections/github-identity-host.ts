import { handleCopyButton } from "../../components/copy-button.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsRow,
  renderSettingsSecretInput,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatDateTimeMs } from "../../lib/format.ts";

export const githubIdentityHost = {
  t,
  icons,
  handleCopyButton,
  externalLinkTarget: EXTERNAL_LINK_TARGET,
  buildExternalLinkRel,
  formatUiExternalText,
  formatDateTimeMs,
  renderSettingsRow,
  renderSettingsSecretInput,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
};
