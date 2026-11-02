export function createMeetingStatusPreludeFragments({
  guestName,
  displayName,
  manualActionReasonPrefix,
}: {
  guestName: string;
  displayName: string;
  manualActionReasonPrefix: string;
}) {
  return {
    guestName: (
      replaceExisting: boolean,
    ) => `  const guestInput = first(selectors.guestName) || [...document.querySelectorAll("input")].find((input) =>
    /enter your name|type your name|your name|display name/i.test(label(input) + " " + (input.placeholder || ""))
  );
  if (canMutateSession && identityVerifiedBeforeCall && autoJoin && guestInput && ${replaceExisting ? `guestInput.value !== ${JSON.stringify(guestName)}` : "!guestInput.value"}) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    guestInput.focus();
    if (setter) setter.call(guestInput, ${JSON.stringify(guestName)});
    else guestInput.value = ${JSON.stringify(guestName)};
    guestInput.dispatchEvent(new Event("input", { bubbles: true }));
    guestInput.dispatchEvent(new Event("change", { bubbles: true }));
  }`,
    preservedIdentity: `  const identityPreservedInCall = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    leave &&
    leave.isConnected !== false &&
    (
      identityAdoptedInCall ||
      identityRerenderedInCall ||
      (
        priorMeeting?.inCallControl === leave &&
        priorMeeting?.inCallUrl === location.href
      )
    )
  );
  const identityVerified = identityVerifiedBeforeCall || identityPreservedInCall;`,
    virtualAudioInput: ({
      beforeEnumerationSource = "",
      selectionSource,
      afterSelectionSource = "",
    }: {
      beforeEnumerationSource?: string;
      selectionSource: string;
      afterSelectionSource?: string;
    }) => `  const { isVirtualAudioDevice, isVirtualAudioDeviceNode, microphoneDeviceRoots, selectedMicrophoneLabel } = meetingAudioInput;
  let audioInputRouted;
  let audioInputDeviceLabel;
  let audioInputRouteError;
  const ensureVirtualAudioInput = async () => {
${beforeEnumerationSource}    if (!navigator.mediaDevices?.enumerateDevices) return false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const input = devices.find(
        (device) => device.kind === "audioinput" && isVirtualAudioDevice(device.label)
      );
      if (!input?.deviceId) return false;
      audioInputDeviceLabel = input.label || "Virtual audio device";
      // ${displayName} hides the selected-device control after admission. Reopen the in-call audio
      // options and verify the current selection before unmuting; installed devices alone
      // do not prove which microphone ${displayName} is using.
${selectionSource}
      if (!selected && canMutateSession) {
        const settings = first(selectors.deviceSettings);
        if (settings) {
          settings.click();
          await waitForUi();
        }
        const { control } = microphoneDeviceRoots();
        if (control?.tagName?.toLowerCase() === "select") {
          const options = [...control.options];
          const option = options.find(isVirtualAudioDeviceNode);
          if (option) {
            control.value = option.value;
            control.dispatchEvent(new Event("change", { bubbles: true }));
            await waitForUi();
          }
        } else if (control) {
          clickable(control)?.click?.();
          await waitForUi();
        }
        const choices = microphoneDeviceRoots().roots.flatMap((root) =>
          selectors.audioDeviceOptions.flatMap((selector) => [
            ...(root.querySelectorAll?.(selector) || []),
          ])
        );
        const choice = choices.find(isVirtualAudioDeviceNode);
        if (choice && choice.getAttribute?.("aria-selected") !== "true") {
          clickable(choice)?.click?.();
          await waitForUi();
        }
        selected = Boolean(selectedMicrophoneLabel());
      }
${afterSelectionSource}      return selected;
    } catch (error) {
      audioInputRouteError = error?.message || String(error);
      return false;
    }
  };`,
    prejoinMicrophone: ({
      unroutedSource,
      afterRoutedSource = "",
      muteInCall,
    }: {
      unroutedSource: string;
      afterRoutedSource?: string;
      muteInCall: boolean;
    }) => `  if (identityVerified && !inCall && allowMicrophone && microphone) {
    audioInputRouted = await ensureVirtualAudioInput();
    if (!audioInputRouted) {
      if (canMutateSession && microphoneState === "on") {
        microphone.click();
        await refreshMicrophoneState();
      }
${unroutedSource}
    } else if (canMutateSession && microphoneState === "off") {
      microphone.click();
      await refreshMicrophoneState();
      if (microphoneState === "on") {
        notes.push("Unmuted the ${displayName} microphone after verifying the virtual audio input.");
      }
    }
${afterRoutedSource}  } else if (canMutateSession && identityVerified && ${muteInCall ? "" : "!inCall && "}!allowMicrophone && microphoneState === "on") {
      microphone.click();
      await refreshMicrophoneState();
      if (microphoneState === "off") {
        notes.push("Muted the ${displayName} microphone for observe-only mode.");
      }
  }`,
    inCallMicrophone: `  if (identityVerified && inCall && allowMicrophone) {
    if (!selectedMicrophoneLabel() && canMutateSession && microphoneState === "on") {
      microphone?.click();
      await refreshMicrophoneState();
    }
    audioInputRouted = await ensureVirtualAudioInput();
    if (audioInputRouted && canMutateSession && microphoneState === "off") {
      microphone?.click();
      await refreshMicrophoneState();
    } else if (!audioInputRouted && canMutateSession && microphoneState === "on") {
      microphone?.click();
      await refreshMicrophoneState();
      if (microphoneState === "off") {
        notes.push("Muted the ${displayName} microphone because the virtual audio input could not be reverified.");
      }
    }
  }`,
    manualActions: ({
      loginDisplayName = displayName,
      inCallControls,
    }: {
      loginDisplayName?: string;
      inCallControls: boolean;
    }) => `  let microphonePermissionState;
  if (allowMicrophone && navigator.permissions?.query) {
    try {
      microphonePermissionState = (await navigator.permissions.query({ name: "microphone" })).state;
    } catch {}
  }
  const devicePermissionPrompt = !dismissedDevicePrompt && Boolean(
    first(selectors.permissionPrompt) || continueWithoutDevices
  );
  // ${displayName} shows the same no-audio/video warning when only camera access is denied.
  // A granted microphone plus the verified virtual audio input is sufficient for talk-back.
  const permissionRequired = devicePermissionPrompt &&
    (!allowMicrophone || microphonePermissionState !== "granted");
  let manualAction;
  if (committedOwnerConflict && !canMutateSession) {
    manualAction = manualActionFor("${manualActionReasonPrefix}-session-conflict", "This ${displayName} tab is owned by another active meeting session.");
  } else if (!inCall && loginRequired) {
    manualAction = manualActionFor("${manualActionReasonPrefix}-login-required", tenantLoginRequired ? "This ${displayName} tenant requires sign-in or email verification. Complete it in the OpenClaw browser profile, then retry." : "Sign in to ${loginDisplayName} in the OpenClaw browser profile, then retry the meeting join.");
  } else if (!inCall && lobbyWaiting) {
    manualAction = manualActionFor("${manualActionReasonPrefix}-admission-required", "Admit the OpenClaw guest from the ${loginDisplayName} lobby, then retry speech.");
  } else if (!inCall && permissionRequired) {
    manualAction = manualActionFor("${manualActionReasonPrefix}-permission-required", allowMicrophone ? "Allow microphone permission for ${displayName} in the OpenClaw browser profile, then retry." : "Dismiss the ${displayName} device-permission prompt or continue without devices, then retry.");
  } else if (${inCallControls ? "" : "!inCall && "}controlManualAction) {
    manualAction = controlManualAction;
  }
  let clickedJoin = false;
  if (canMutateSession && identityVerified && autoJoin && !inCall && join && !join.disabled && !manualAction) {
    join.click();
    clickedJoin = true;
    notes.push("Clicked the ${displayName} guest join button.");
  }`,
  };
}
