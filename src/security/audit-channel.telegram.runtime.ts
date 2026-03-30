import {
	isNumericTelegramUserId,
	normalizeTelegramAllowFromEntry,
} from "../channels/read-only-account-inspect.telegram.js";

export const auditChannelTelegramRuntime = {
	isNumericTelegramUserId,
	normalizeTelegramAllowFromEntry,
};
