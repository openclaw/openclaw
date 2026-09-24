export class ApnsRegistrationPairingChangedError extends Error {
  constructor() {
    super("node pairing changed before APNs registration");
    this.name = "ApnsRegistrationPairingChangedError";
  }
}
