declare module "node-edge-tts" {
	export type EdgeTTSOptions = {
		voice?: string;
		lang?: string;
		outputFormat?: string;
		saveSubtitles?: boolean;
		proxy?: string;
		rate?: string;
		pitch?: string;
		volume?: string;
		timeout?: number;
	};

	export class EdgeTTS {
		constructor(options?: EdgeTTSOptions);
		ttsPromise(text: string, outputPath: string): Promise<void>;
	}
}

declare module "node-edge-tts/dist/drm.js" {
	export const CHROMIUM_FULL_VERSION: string;
	export const TRUSTED_CLIENT_TOKEN: string;
	export function generateSecMsGecToken(): string;
}
