export class WizardCancelledError extends Error {
    constructor(message = "wizard cancelled") {
        super(message);
        this.name = "WizardCancelledError";
    }
}
