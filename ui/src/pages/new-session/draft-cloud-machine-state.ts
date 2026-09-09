import { cloudMachinesForOs, defaultCloudOs, type DraftCloudProfile } from "./discovery.ts";

type CloudOverride = { os?: string; machineClass?: string };

export class DraftCloudMachineState {
  private readonly overrides = new Map<string, CloudOverride>();

  clear() {
    this.overrides.clear();
  }

  applyPending(profileId: string, machineClass?: string, os?: string) {
    if (machineClass || os) {
      this.overrides.set(profileId, { machineClass, os });
    } else {
      this.overrides.delete(profileId);
    }
  }

  resolve(profileId: string): string {
    return this.overrides.get(profileId)?.machineClass ?? "";
  }

  resolveOs(profileId: string): string {
    return this.overrides.get(profileId)?.os ?? "";
  }

  selection(profileId: string) {
    return { machineClass: this.resolve(profileId), os: this.resolveOs(profileId) } as const;
  }

  selectedOs(profile: DraftCloudProfile): string {
    return this.resolveOs(profile.id) || defaultCloudOs(profile);
  }

  machines(profile: DraftCloudProfile) {
    return cloudMachinesForOs(profile, this.selectedOs(profile));
  }

  selectOs(
    profileId: string,
    osId: string,
    profiles: readonly DraftCloudProfile[],
    disabled = false,
    onChange?: () => void,
  ): boolean {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    const os = profile?.operatingSystems?.find((candidate) => candidate.id === osId);
    if (disabled || !profile || !os) {
      return false;
    }
    const machineClass = this.resolve(profileId);
    this.applyPending(
      profileId,
      cloudMachinesForOs(profile, os.id).some((machine) => machine.id === machineClass)
        ? machineClass
        : undefined,
      os.id === defaultCloudOs(profile) ? undefined : os.id,
    );
    onChange?.();
    return true;
  }

  select(
    profileId: string,
    machineId: string,
    profiles: readonly DraftCloudProfile[],
    disabled = false,
    onChange?: () => void,
  ): boolean {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    const machine =
      profile && this.machines(profile).find((candidate) => candidate.id === machineId);
    if (disabled || !machine) {
      return false;
    }
    this.applyPending(
      profileId,
      machine.default === true ? undefined : machine.id,
      this.resolveOs(profileId),
    );
    onChange?.();
    return true;
  }
}
