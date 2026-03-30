declare module "@create-markdown/preview" {
	export type PreviewThemeOptions = {
		sanitize?: ((html: string) => string) | undefined;
	};

	export function applyPreviewTheme(
		html: string,
		options?: PreviewThemeOptions,
	): string;
}
