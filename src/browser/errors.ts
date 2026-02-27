export class InvalidBrowserFormFieldValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserFormFieldValueError";
  }
}
