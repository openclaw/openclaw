# Compatible-copy regression fixture

`video-compatible-copy.mp4` is purpose-generated synthetic media, licensed under
the repository's MIT license. It contains no recording of a person or device.
SHA-256: `fb1aa66c3bfaf36817e0bf66d052814591dc9f6f17976a5c41a7cce8c99136a7`.

Created with Mediabunny 1.62.1, Chromium 156.0.8078.4 native H.264 encoding, and
the official @mediabunny/aac-encoder 1.61.5 used **only for fixture creation**.
No custom codec is installed in the application or its conversion worker.

Six seconds, 320×180 at 30 fps, upright white arrow, red/blue/green/yellow borders,
moving cyan bar and binary frame counter. White flashes at 0.5 and 5.5 seconds
coincide with 100 ms stereo markers (1800 Hz left, 2400 Hz right). Continuous
synthetic melody uses 330/440/550/660 Hz at 48 kHz, two channels. Video is SDR,
BT.709 primaries/matrix with sRGB transfer.

The muxer wrote video plus two AAC tracks. The second AAC sample entry was
changed from mp4a to apac, and its esds child changed to a same-sized free box.
This intentionally creates an unknown audio sample entry. It is **not Apple
APAC audio**, and a passing regression does not establish genuine APAC support.
The valid AAC track retains real audible samples. Padding in the browser test
adds a valid 512 KiB free box to exceed a controlled 512 KiB attachment budget.

The test exercises the real composer and worker, separate disclosure/consent,
cancel/remove/reselect, source download byte equality, draft/other-attachment
preservation, actual output codecs, size, unmuted playback and decoded waveform.
Physical listening, A/V tolerances, genuine APAC and device-specific
qualifications remain independent gates. MP4 and WebM are separate outcomes;
an environment without an AAC encoder does not qualify MP4 output.
