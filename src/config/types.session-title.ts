export type SessionTitleConfig = {
  /** Enable AI-generated session titles. Default: true. */
  enabled?: boolean;
  /** Number of user-assistant exchanges before generating a title. Default: 3. */
  turnsBeforeTitle?: number;
  /** Maximum length of the generated title in characters. Default: 50. */
  maxChars?: number;
};
